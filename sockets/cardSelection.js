   const GameCard = require("../models/GameCard");
   const { findFieldsByValue, batchHGet } = require("../utils/redisHelpers");
   

   module.exports = function CardSelectionHandler(socket, io, redis) {
        socket.on("cardSelected", async (data) => {
                const { telegramId, gameId, cardIds, cardsData, requestId } = data;

                const strTelegramId = String(telegramId);
                const strGameId = String(gameId);
                
                // Redis Keys
                const userActionLockKey = `lock:userAction:${strGameId}:${strTelegramId}`;
                const userHeldCardsKey = `userHeldCards:${strGameId}:${strTelegramId}`;
                const takenCardsKey = `takenCards:${strGameId}`; // The Global "Taken" Set
                const gameCardsKey = `gameCards:${strGameId}`;   // The Assignment Map

                // 1. Acquire User-Level Lock (Prevent spamming clicks)
                const userLock = await redis.set(userActionLockKey, requestId, "NX", "EX", 2);
                if (!userLock) {
                    return socket.emit("cardError", {
                        message: "⏳ Processing... please wait.",
                        requestId
                    });
                }

                try {
                    // 2. Determine the card the user is actually trying to claim
                    // We compare their new request against what they already hold in Redis
                    const myOldCardIds = await redis.sMembers(userHeldCardsKey);
                    const myOldCardIdSet = new Set(myOldCardIds);
                    
                    const cardsToAdd = cardIds.map(String).filter(id => !myOldCardIdSet.has(id));
                    const cardsToRelease = myOldCardIds.filter(id => !new Set(cardIds.map(String)).has(id));

                    // 3. ATOMIC CLAIM (The "Method A" Magic)
                    if (cardsToAdd.length > 0) {
                        for (const cardId of cardsToAdd) {
                            // SADD returns 1 if added (free), 0 if exists (taken)
                            const wasFree = await redis.sAdd(takenCardsKey, cardId);
                            
                            if (wasFree === 0) {
                                // REJECTION: Someone else got it first
                                throw new Error(`Card ${cardId} was just taken by another player!`);
                            }
                        }
                    }

                    // 4. PREPARE UPDATES (Since claim was successful)
                    const redisMulti = redis.multi();
                    const dbUpdatePromises = [];

                    // A) Handle Releases
                    if (cardsToRelease.length > 0) {
                        redisMulti.sRem(takenCardsKey, ...cardsToRelease);
                        redisMulti.sRem(userHeldCardsKey, ...cardsToRelease);
                        redisMulti.hDel(gameCardsKey, ...cardsToRelease);
                        
                        dbUpdatePromises.push(
                            GameCard.updateMany(
                                { gameId: strGameId, cardId: { $in: cardsToRelease.map(Number) } },
                                { $set: { isTaken: false, takenBy: null } }
                            )
                        );
                    }

                    // B) Handle Additions
                    if (cardsToAdd.length > 0) {
                        for (const cardId of cardsToAdd) {
                            const cardGrid = cardsData[cardId];
                            if (!cardGrid) throw new Error(`Missing layout for card ${cardId}`);
                            
                            const cleanCard = cardGrid.map(row => row.map(c => (c === "FREE" ? 0 : Number(c))));

                            redisMulti.sAdd(userHeldCardsKey, cardId);
                            redisMulti.hSet(gameCardsKey, cardId, strTelegramId);
                            
                            dbUpdatePromises.push(
                                GameCard.updateOne(
                                    { gameId: strGameId, cardId: Number(cardId) },
                                    { $set: { card: cleanCard, isTaken: true, takenBy: strTelegramId } },
                                    { upsert: true }
                                )
                            );
                        }
                    }

                    // 5. EXECUTE ALL
                    await Promise.all([
                        ...dbUpdatePromises,
                        redisMulti.exec()
                    ]);

                    // 6. CONFIRM & BROADCAST
                    const finalHeldCards = await redis.sMembers(userHeldCardsKey);
                    
                    socket.emit("cardConfirmed", {
                        cardIds: finalHeldCards.map(Number),
                        requestId
                    });

                    io.to(strGameId).emit("cardsUpdated", {
                        released: cardsToRelease,
                        selected: cardsToAdd,
                        ownerId: strTelegramId
                    });

                } catch (err) {
                    console.error("Selection Error:", err.message);
                    
                    // If we partially succeeded in SADD but failed later, 
                    // we should ideally roll back, but for now, sync the UI:
                    const myCurrentCards = await redis.sMembers(userHeldCardsKey);
                    
                    socket.emit("cardError", { 
                        message: err.message, 
                        requestId,
                        currentHeldCardIds: myCurrentCards.map(Number)
                    });
                } finally {
                    await redis.del(userActionLockKey);
                }
            });


    socket.on("cardDeselected", async ({ telegramId, cardId, gameId }) => {
                const strTelegramId = String(telegramId);
                const strCardId = String(cardId);
                const gameCardsKey = `gameCards:${gameId}`;

                // Verify they own the card
                const owner = await redis.hGet(gameCardsKey, strCardId);
                if (owner !== strTelegramId) {
                    return; // Not their card
                }

                // Release the card
                await redis.hDel(gameCardsKey, strCardId);
                await GameCard.updateOne(
                    { gameId, cardId: Number(strCardId) },
                    { $set: { isTaken: false, takenBy: null } }
                );

                // Tell everyone else it's free
                socket.to(gameId).emit("cardReleased", { 
                    cardId: strCardId, 
                    telegramId: strTelegramId 
                });
            });



    socket.on("unselectCardOnLeave", async ({ gameId, telegramId }) => {
            console.log("unselectCardOnLeave is called for", telegramId);

            try {
                const strGameId = String(gameId);
                // ✅ CRITICAL FIX 1: Trim the ID (Just like playerLeave)
                const strTelegramId = String(telegramId).trim(); 
                const gameCardsKey = `gameCards:${strGameId}`;
                const userHeldCardsKey = `userHeldCards:${strGameId}:${strTelegramId}`;
                const cardsToRelease = await redis.sMembers(userHeldCardsKey);

                // --- 2. Release Cards (If any exist) ---
                if (cardsToRelease.length > 0) {
                    console.log(`🍔 releasing ${cardsToRelease.length} cards for ${strTelegramId}`);

                    // A) Remove from Redis Hash
                    //await redis.hDel(gameCardsKey, ...cardsToRelease);
                    await redis.del(userHeldCardsKey);

                    // B) Update MongoDB
                    await GameCard.updateMany(
                        { gameId: strGameId, cardId: { $in: cardsToRelease.map(Number) } },
                        { $set: { isTaken: false, takenBy: null } }
                    );

                    // ✅ CRITICAL FIX 3: Double-Check (The "Leftover" Check)
                    // Sometimes high-concurrency causes the first delete to miss a key. 
                    // 1. Check the "User Pocket" (Set) instead of the whole Game Hash
                    const leftovers = await redis.sMembers(userHeldCardsKey);

                    if (leftovers.length > 0) {
                        console.log(`⚠️ Cleaning up leftover cards: ${leftovers.join(', ')}`);

                        // 2. Remove from the Master Game Hash (The 'Map')
                        await redis.hDel(gameCardsKey, ...leftovers);
                        
                        // 3. Destroy the "Pocket" Set entirely since the user is leaving
                        await redis.del(userHeldCardsKey);

                        // 4. Merge leftovers into cardsToRelease uniquely
                        leftovers.forEach(id => {
                            if (!cardsToRelease.includes(id)) {
                                cardsToRelease.push(id);
                            }
                        });
                    }

                    // 5. Notify Frontend (Now cardsToRelease contains EVERYTHING)
                    io.to(strGameId).emit("cardsReleased", { 
                        cardIds: cardsToRelease, 
                        telegramId: strTelegramId 
                    });
                    
                    console.log(`🧹🔥🔥🔥🔥 Released cards from Redis: ${cardsToRelease.join(', ')}`);
                } else {
                    console.log(`ℹ️ No cards found in Redis for ${strTelegramId} to release.`);
                }

                // --- 3. Clean up Session Keys & SETS ---
                // Removing from SETS is required to fix the "Player Count"
                await Promise.all([
                    redis.hDel("userSelections", socket.id),
                    redis.hDel("userSelections", strTelegramId),
                    redis.hDel("userSelectionsByTelegramId", strTelegramId),
                    redis.del(`activeSocket:${strTelegramId}:${socket.id}`),
                    
                    // ✅ CRITICAL FIX 4: Remove from gameRooms/gameSessions (Just like playerLeave)
                    redis.sRem(`gameSessions:${strGameId}`, strTelegramId), 
                    redis.sRem(`gameRooms:${strGameId}`, strTelegramId) 
                ]);
                
                // Emit updated player count so the frontend updates immediately
                const playerCount = await redis.sCard(`gameRooms:${strGameId}`);
                io.to(strGameId).emit("playerCountUpdate", { gameId: strGameId, playerCount });

            } catch (err) {
                console.error("unselectCardOnLeave error:", err);
            }
        });
    }