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
            // If locked, we just tell the UI to wait, preventing race conditions from the same user
            return socket.emit("cardError", {
                message: "⏳ Processing... please wait.",
                requestId
            });
        }

        // Track successfully claimed cards for potential rollback
        const successfullyClaimed = [];

        try {
            // 2. Determine the card the user is actually trying to claim
            const myOldCardIds = await redis.sMembers(userHeldCardsKey);
            const myOldCardIdSet = new Set(myOldCardIds);
            
            // Filter: What are they adding? What are they releasing?
            const cardsToAdd = cardIds.map(String).filter(id => !myOldCardIdSet.has(id));
            const cardsToRelease = myOldCardIds.filter(id => !new Set(cardIds.map(String)).has(id));

            // 3. ATOMIC CLAIM (The "Method A" Magic)
            // We do this BEFORE the multi-transaction to ensure we own the specific items
            if (cardsToAdd.length > 0) {
                for (const cardId of cardsToAdd) {
                    // SADD returns 1 if added (free), 0 if exists (taken)
                    const wasFree = await redis.sAdd(takenCardsKey, cardId);
                    
                    if (wasFree === 0) {
                        // REJECTION: Someone else got it first
                        throw new Error(`Card ${cardId} was just taken by another player!`);
                    }
                    // Track success for rollback if needed later
                    successfullyClaimed.push(cardId);
                }
            }

            // 4. PREPARE REDIS UPDATES 
            // We prepare the batch, but we DO NOT await MongoDB here.
            const redisMulti = redis.multi();
            
            // A) Handle Releases (User deselected these)
            if (cardsToRelease.length > 0) {
                redisMulti.sRem(takenCardsKey, ...cardsToRelease);
                redisMulti.sRem(userHeldCardsKey, ...cardsToRelease);
                redisMulti.hDel(gameCardsKey, ...cardsToRelease);
            }

            // B) Handle Additions (User selected these)
            if (cardsToAdd.length > 0) {
                for (const cardId of cardsToAdd) {
                    const cardGrid = cardsData[cardId];
                    if (!cardGrid) throw new Error(`Missing layout for card ${cardId}`);
                    
                    redisMulti.sAdd(userHeldCardsKey, cardId);
                    redisMulti.hSet(gameCardsKey, cardId, strTelegramId);
                }
            }

            // 5. EXECUTE REDIS TRANSACTION (The "Source of Truth" Commit)
            // We await ONLY Redis here. This is fast (ms).
            await redisMulti.exec();

            // 6. INSTANT RESPONSE (Optimistic Success)
            // We tell the user "You got it" immediately.
            socket.emit("cardConfirmed", {
                cardIds: cardIds.map(Number),
                requestId
            });

            // Broadcast to room
            io.to(strGameId).emit("cardsUpdated", {
                released: cardsToRelease,
                selected: cardsToAdd,
                ownerId: strTelegramId
            });

            // 7. FIRE-AND-FORGET DB WRITES (Background Persistence)
            // This runs effectively in a "background thread". We do NOT await it.
            const dbUpdatePromises = [];

            if (cardsToRelease.length > 0) {
                dbUpdatePromises.push(
                    GameCard.updateMany(
                        { gameId: strGameId, cardId: { $in: cardsToRelease.map(Number) } },
                        { $set: { isTaken: false, takenBy: null } }
                    )
                );
            }

            if (cardsToAdd.length > 0) {
                for (const cardId of cardsToAdd) {
                    const cardGrid = cardsData[cardId];
                    const cleanCard = cardGrid.map(row => row.map(c => (c === "FREE" ? 0 : Number(c))));
                    
                    dbUpdatePromises.push(
                        GameCard.updateOne(
                            { gameId: strGameId, cardId: Number(cardId) },
                            { $set: { card: cleanCard, isTaken: true, takenBy: strTelegramId } },
                            { upsert: true }
                        )
                    );
                }
            }

            // Execute DB writes without blocking the user
            Promise.all(dbUpdatePromises).catch(err => {
                console.error(`[BACKGROUND WRITE FAIL] Game: ${strGameId} User: ${strTelegramId}`, err);
                // Optional: Push to a retry queue (e.g., BullMQ) if consistency is critical
            });

        } catch (err) {
            console.error("Selection Error:", err.message);

            // 🚨 ROLLBACK MECHANISM 🚨
            // If we successfully claimed cards in Step 3 (sAdd returned 1)
            // but failed in Step 4 or 5 (e.g., missing data, Redis connection blip),
            // we MUST release them so they don't become "Ghost Cards".
            if (successfullyClaimed.length > 0) {
                console.log(`↺ Rolling back claims for: ${successfullyClaimed.join(', ')}`);
                // We use a separate try/catch so rollback failure doesn't crash the crash handler
                try {
                    await redis.sRem(takenCardsKey, ...successfullyClaimed);
                } catch (rollbackErr) {
                    console.error("CRITICAL: Rollback failed!", rollbackErr);
                }
            }
            
            // Sync the UI with reality
            const myCurrentCards = await redis.sMembers(userHeldCardsKey);
            
            socket.emit("cardError", { 
                message: err.message, 
                requestId,
                currentHeldCardIds: myCurrentCards.map(Number)
            });
        } finally {
            // Always release the user lock
            await redis.del(userActionLockKey);
        }
    });

    // --- (Keep existing cardDeselected logic, it is low-risk) ---
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

    // --- (Keep existing unselectCardOnLeave logic) ---
    socket.on("unselectCardOnLeave", async ({ gameId, telegramId }) => {
        console.log("unselectCardOnLeave is called for", telegramId);

        try {
            const strGameId = String(gameId);
            const strTelegramId = String(telegramId).trim(); 
            const gameCardsKey = `gameCards:${strGameId}`;
            const userHeldCardsKey = `userHeldCards:${strGameId}:${strTelegramId}`;
            const cardsToRelease = await redis.sMembers(userHeldCardsKey);

            if (cardsToRelease.length > 0) {
                // A) Remove from Redis Hash & Set
                await redis.del(userHeldCardsKey);

                // B) Fire-and-forget MongoDB Update
                GameCard.updateMany(
                    { gameId: strGameId, cardId: { $in: cardsToRelease.map(Number) } },
                    { $set: { isTaken: false, takenBy: null } }
                ).catch(err => console.error("Background Leave Update Failed", err));

                // C) Double-Check Leftovers (Consistency Check)
                const leftovers = await redis.sMembers(userHeldCardsKey);
                if (leftovers.length > 0) {
                    await redis.hDel(gameCardsKey, ...leftovers);
                    await redis.del(userHeldCardsKey);
                    leftovers.forEach(id => {
                        if (!cardsToRelease.includes(id)) cardsToRelease.push(id);
                    });
                }

                io.to(strGameId).emit("cardsReleased", { 
                    cardIds: cardsToRelease, 
                    telegramId: strTelegramId 
                });
            }

            await Promise.all([
                redis.hDel("userSelections", socket.id),
                redis.hDel("userSelections", strTelegramId),
                redis.hDel("userSelectionsByTelegramId", strTelegramId),
                redis.del(`activeSocket:${strTelegramId}:${socket.id}`),
                redis.sRem(`gameSessions:${strGameId}`, strTelegramId), 
                redis.sRem(`gameRooms:${strGameId}`, strTelegramId) 
            ]);
            
            const playerCount = await redis.sCard(`gameRooms:${strGameId}`);
            io.to(strGameId).emit("playerCountUpdate", { gameId: strGameId, playerCount });

        } catch (err) {
            console.error("unselectCardOnLeave error:", err);
        }
    });
}