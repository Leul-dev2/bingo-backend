   const GameCard = require("../models/GameCard");
   const { findFieldsByValue, batchHGet } = require("../utils/redisHelpers");
   

   module.exports = function CardSelectionHandler(socket, io, redis) {
   socket.on("cardSelected", async (data) => {
        // --- NEW ---: Destructure the array and map from the frontend
        const { telegramId, gameId, cardIds, cardsData, requestId } = data;

        // --- 1. Data Sanitization & Key Preparation ---
        const strTelegramId = String(telegramId);
        const strGameId = String(gameId);
        const userActionLockKey = `lock:userAction:${strGameId}:${strTelegramId}`;
        
        // Redis keys
        const gameCardsKey = `gameCards:${strGameId}`;
        const userSelectionsKey = `userSelections`; // For the socket
        const userSelectionsByTelegramIdKey = `userSelectionsByTelegramId`; // Legacy
        const userLastRequestIdKey = `userLastRequestId`;

        // --- FIX ---: Define cardLockKeys in the outer scope
        let cardLockKeys = [];

        // --- 2. Acquire User-Level Lock ---
        const userLock = await redis.set(userActionLockKey, requestId, "NX", "EX", 10);
        if (!userLock) {
            return socket.emit("cardError", {
                message: "⏳ Your previous action is still processing. Please wait a moment.",
                requestId
            });
        }

        try {
            // --- 3. Validate Input ---
            if (!Array.isArray(cardIds) || cardIds.length > 2) {
                throw new Error("Invalid card selection. Must be an array with 0-2 cards.");
            }
            const newCardIdSet = new Set(cardIds.map(String));

            const myOldCardIds = await findFieldsByValue(redis, gameCardsKey, strTelegramId);
            console.log("Backend sees user owns: 🎴🎴🎴🃏", myOldCardIds);
            const myOldCardIdSet = new Set(myOldCardIds);

            // --- 5. Determine Cards to Add and Release ---
            const cardsToAdd = [];
            for (const cardId of newCardIdSet) {
                if (!myOldCardIdSet.has(cardId)) {
                    cardsToAdd.push(cardId);
                }
            }

            const cardsToRelease = [];
            for (const cardId of myOldCardIdSet) {
                if (!newCardIdSet.has(cardId)) {
                    cardsToRelease.push(cardId);
                }
            }
            
            // --- 6. Check for Conflicts (Cards to Add) ---
            // --- FIX ---: Assign value to the outer-scoped variable
            cardLockKeys = cardsToAdd.map(cardId => `lock:card:${strGameId}:${cardId}`);
            let locksAcquired = true;

            if (cardsToAdd.length > 0) {
                const cardStatuses = await batchHGet(redis, gameCardsKey, cardsToAdd);

                for (const cardId of cardsToAdd) {
                    const existingOwnerId = cardStatuses[cardId]; // Use the targeted result
                    if (existingOwnerId && existingOwnerId !== strTelegramId) {
                        throw new Error(`Card ${cardId} is already taken.`);
                    }
                                
                    const cardLock = await redis.set(`lock:card:${strGameId}:${cardId}`, strTelegramId, "NX", "EX", 10);
                    if (!cardLock) {
                        locksAcquired = false;
                        break; 
                    }
                }
            }

            if (!locksAcquired) {
                throw new Error("One of your selected cards is currently being claimed. Please try again.");
            }

            // --- 7. Perform Atomic Updates ---
            const dbUpdatePromises = [];
            const redisMulti = redis.multi();

            // A) Release old cards
            if (cardsToRelease.length > 0) {
                dbUpdatePromises.push(
                    GameCard.updateMany(
                        { gameId: strGameId, cardId: { $in: cardsToRelease.map(Number) } },
                        { $set: { isTaken: false, takenBy: null } }
                    )
                );
                redisMulti.hDel(gameCardsKey, ...cardsToRelease);
            }

            // B) Add new cards
            if (cardsToAdd.length > 0) {
                for (const cardId of cardsToAdd) {
                    const strCardId = String(cardId);
                    const cardGrid = cardsData[strCardId];
                    if (!cardGrid) {
                        throw new Error(`Missing card data for card ${strCardId}`);
                    }
                    const cleanCard = cardGrid.map(row => row.map(c => (c === "FREE" ? 0 : Number(c))));

                    dbUpdatePromises.push(
                        GameCard.updateOne(
                            { gameId: strGameId, cardId: Number(strCardId) },
                            { $set: { card: cleanCard, isTaken: true, takenBy: strTelegramId } },
                            { upsert: true }
                        )
                    );
                    redisMulti.hSet(gameCardsKey, strCardId, strTelegramId);
                }
            }

            // C) Update session/legacy keys
            const lastCardId = cardIds.length > 0 ? cardIds[cardIds.length - 1] : null;
            if (lastCardId) {
                const lastCardGrid = cardsData[lastCardId];
                const cleanCard = lastCardGrid ? lastCardGrid.map(row => row.map(c => (c === "FREE" ? 0 : Number(c)))) : [];
                const selectionData = JSON.stringify({
                    telegramId: strTelegramId,
                    cardId: String(lastCardId),
                    card: cleanCard,
                    gameId: strGameId
                });
                redisMulti.hSet(userSelectionsKey, socket.id, selectionData);
                redisMulti.hSet(userSelectionsByTelegramIdKey, strTelegramId, selectionData);
            } else {
                redisMulti.hDel(userSelectionsKey, socket.id);
                redisMulti.hDel(userSelectionsByTelegramIdKey, strTelegramId);
            }
            redisMulti.hSet(userLastRequestIdKey, strTelegramId, requestId);
            
            await Promise.all([
                ...dbUpdatePromises,
                redisMulti.exec()
            ]);

            // --- 8. Broadcast Updates & Confirmations ---
            socket.emit("cardConfirmed", {
                cardIds: newCardIdSet.size > 0 ? Array.from(newCardIdSet).map(Number) : [],
                requestId
            });

            for (const cardId of cardsToRelease) {
                socket.to(strGameId).emit("cardReleased", { telegramId: strTelegramId, cardId: cardId });
            }
            for (const cardId of cardsToAdd) {
                socket.to(strGameId).emit("otherCardSelected", { telegramId: strTelegramId, cardId: cardId });
            }

           
            const numberOfPlayers = await redis.sCard(`gameSessions:${strGameId}`);
            io.to(strGameId).emit("gameid", { gameId: strGameId, numberOfPlayers });

        } catch (err) {
            console.error(`❌ cardSelected error for game ${strGameId}, user ${strTelegramId}:`, err);
            
            // --- FIX ---: Correctly fetch the user's *actual* current cards on error
            const allCards = await redis.hGetAll(gameCardsKey);
            const oldCardIds = [];
            for (const [cardId, ownerId] of Object.entries(allCards)) {
                 if (ownerId === strTelegramId) {
                    oldCardIds.push(Number(cardId));
                 }
            }
                                
            socket.emit("cardError", { 
                message: err.message || "An unexpected error occurred. Please try again.", 
                requestId,
                currentHeldCardIds: oldCardIds 
            });
        } finally {
            // --- 9. Release All Locks ---
            await redis.del(userActionLockKey);
            
            // --- FIX ---: Check if cardLockKeys has keys before looping
            if (cardLockKeys.length > 0) {
                for (const key of cardLockKeys) {
                    await redis.del(key); 
                }
            }
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

               const cardsToRelease = await findFieldsByValue(redis, gameCardsKey, strTelegramId);

                // --- 2. Release Cards (If any exist) ---
                if (cardsToRelease.length > 0) {
                    console.log(`🍔 releasing ${cardsToRelease.length} cards for ${strTelegramId}`);

                    // A) Remove from Redis Hash
                    await redis.hDel(gameCardsKey, ...cardsToRelease);

                    // B) Update MongoDB
                    await GameCard.updateMany(
                        { gameId: strGameId, cardId: { $in: cardsToRelease.map(Number) } },
                        { $set: { isTaken: false, takenBy: null } }
                    );

                    // ✅ CRITICAL FIX 3: Double-Check (The "Leftover" Check)
                    // Sometimes high-concurrency causes the first delete to miss a key. 
                    // We check again immediately.
                    const verifyGameCards = await redis.hGetAll(gameCardsKey);
                    const leftovers = Object.entries(verifyGameCards)
                        .filter(([_, ownerId]) => String(ownerId).trim() == strTelegramId)
                        .map(([cardId]) => cardId);

                    if (leftovers.length > 0) {
                        console.log(`⚠️ Found leftover cards after release, deleting again: ${leftovers.join(', ')}`);
                        await redis.hDel(gameCardsKey, ...leftovers);
                        cardsToRelease.push(...leftovers);
                    }

                    // C) Notify Frontend
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