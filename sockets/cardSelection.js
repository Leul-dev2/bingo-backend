   
   const GameCard = require("../models/GameCard");
   const { findFieldsByValue, getFullHashAsObject, batchHGet } = require("../utils/redisHelpers");
   

   module.exports = function CardSelectionHandler(socket, io, redis) {
    socket.on("cardSelected", async (data) => {
        const { telegramId, gameId, cardIds, cardsData, requestId } = data;

        // --- 1. Data Sanitization ---
        const strTelegramId = String(telegramId).trim();
        const strGameId = String(gameId);
        const userActionLockKey = `lock:userAction:${strGameId}:${strTelegramId}`;
        const gameCardsKey = `gameCards:${strGameId}`;
        const userSelectionsKey = `userSelections`;
        const userSelectionsByTelegramIdKey = `userSelectionsByTelegramId`;
        const userLastRequestIdKey = `userLastRequestId`;

        let cardLockKeys = [];

        // --- 2. Acquire User-Level Lock (Prevent Spam) ---
        const userLock = await redis.set(userActionLockKey, requestId, "NX", "EX", 10);
        if (!userLock) {
            return socket.emit("cardError", {
                message: "⏳ Processing... please wait a moment.",
                requestId
            });
        }

        try {
            // --- 3. Validate Input ---
            if (!Array.isArray(cardIds) || cardIds.length > 2) {
                throw new Error("Invalid selection. Max 2 cards allowed.");
            }
            const newCardIdSet = new Set(cardIds.map(String));

            // --- 4. Discovery Segment (Using findFieldsByValue) ---
            // Efficiently find what the user currently owns via HSCAN
            const myOldCardIds = await findFieldsByValue(redis, gameCardsKey, strTelegramId);
            const myOldCardIdSet = new Set(myOldCardIds.map(String));

            // --- 5. Swap Logic (Determine Add/Release) ---
            const cardsToAdd = [];
            for (const cardId of newCardIdSet) {
                if (!myOldCardIdSet.has(cardId)) cardsToAdd.push(cardId);
            }

            const cardsToRelease = [];
            for (const cardId of myOldCardIdSet) {
                if (!newCardIdSet.has(cardId)) cardsToRelease.push(cardId);
            }

            // --- 6. Security Segment (Conflict Check using batchHGet) ---
            if (cardsToAdd.length > 0) {
                cardLockKeys = cardsToAdd.map(id => `lock:card:${strGameId}:${id}`);
                
                // Only fetch ownership for cards we want to claim
                const currentOwners = await batchHGet(redis, gameCardsKey, cardsToAdd);

                for (const cardId of cardsToAdd) {
                    const existingOwner = currentOwners[cardId];
                    if (existingOwner && existingOwner !== strTelegramId) {
                        throw new Error(`Card ${cardId} is already taken.`);
                    }

                    // Acquire per-card lock
                    const cardLock = await redis.set(`lock:card:${strGameId}:${cardId}`, strTelegramId, "NX", "EX", 10);
                    if (!cardLock) {
                        throw new Error("One of your cards is currently being claimed. Try again.");
                    }
                }
            }

            // --- 7. Execution Segment (Atomic Updates) ---
            const dbUpdatePromises = [];
            const redisMulti = redis.multi();

            // A) Release Old Cards (Delete from Redis)
            if (cardsToRelease.length > 0) {
                dbUpdatePromises.push(
                    GameCard.updateMany(
                        { gameId: strGameId, cardId: { $in: cardsToRelease.map(Number) } },
                        { $set: { isTaken: false, takenBy: null } }
                    )
                );
                redisMulti.hDel(gameCardsKey, ...cardsToRelease);
            }

            // B) Add New Cards (Set in Redis)
            for (const cardId of cardsToAdd) {
                const strCardId = String(cardId);
                const cardGrid = cardsData[strCardId];
                if (!cardGrid) throw new Error(`Missing data for card ${strCardId}`);
                
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

            // C) Update Session Data (Last card selected logic)
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

            await Promise.all([...dbUpdatePromises, redisMulti.exec()]);

            // --- 8. Broadcast Updates ---
            socket.emit("cardConfirmed", {
                cardIds: cardIds.map(Number),
                requestId
            });

            cardsToRelease.forEach(id => socket.to(strGameId).emit("cardReleased", { telegramId: strTelegramId, cardId: id }));
            cardsToAdd.forEach(id => socket.to(strGameId).emit("otherCardSelected", { telegramId: strTelegramId, cardId: id }));

            // Send full state to all (Using helper for speed)
            const [updatedSelections, numberOfPlayers] = await Promise.all([
                getFullHashAsObject(redis, gameCardsKey), // Optimized replacement for hGetAll
                redis.sCard(`gameSessions:${strGameId}`)
            ]);
            io.to(strGameId).emit("currentCardSelections", updatedSelections);
            io.to(strGameId).emit("gameid", { gameId: strGameId, numberOfPlayers });

        } catch (err) {
            console.error(`❌ cardSelected error:`, err);
            // Error Recovery (Use HSCAN helper)
            const currentOwned = await findFieldsByValue(redis, gameCardsKey, strTelegramId);
            socket.emit("cardError", { 
                message: err.message, 
                requestId,
                currentHeldCardIds: currentOwned.map(Number) 
            });
        } finally {
            await redis.del(userActionLockKey);
            if (cardLockKeys.length > 0) {
                for (const key of cardLockKeys) await redis.del(key);
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

                // --- 1. Find ALL cards owned by this user ---
                const allGameCards = await redis.hGetAll(gameCardsKey);
                
                // ✅ CRITICAL FIX 2: Use robust filtering with trim()
                // This catches the cards that strict equality (===) misses
                let cardsToRelease = Object.entries(allGameCards)
                    .filter(([_, ownerId]) => String(ownerId).trim() == strTelegramId)
                    .map(([cardId]) => cardId);

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