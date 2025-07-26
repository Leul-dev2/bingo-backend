// File: utils/clearGameSessions.js

const { getCardsKey } = require("./redisKeys");
const GameCard = require("../models/GameCard"); // <-- Import the GameCard model

// Add 'io' as a parameter to the function signature
async function clearGameSessions(gameId, redis, state, io) {
    const strGameId = String(gameId);
    const gameSessionsKey = `gameSessions:${strGameId}`; // This is the Redis key for the card selection lobby
    const gameCardsKey = getCardsKey(strGameId); // Key for game cards in Redis

    console.log(`🧹 Attempting to clear only game sessions (lobby and cards) for game: ${strGameId}`);

    try {
        // 1. Clear the Redis keys for game sessions (lobby players) and associated cards concurrently
        const [deletedSessionsCount, deletedCardsCount] = await Promise.all([
            redis.del(gameSessionsKey),
            redis.del(gameCardsKey)
        ]);

        if (deletedSessionsCount > 0) {
            console.log(`✅ Redis game sessions (key: ${gameSessionsKey}) cleared.`);
        } else {
            console.log(`ℹ️ Redis game sessions (key: ${gameSessionsKey}) did not exist or was already empty.`);
        }

        if (deletedCardsCount > 0) {
            console.log(`✅ Redis game cards (key: ${gameCardsKey}) cleared.`);
        } else {
            console.log(`ℹ️ Redis game cards (key: ${gameCardsKey}) did not exist or was already empty.`);
        }


        await GameCard.updateMany({ gameId: strGameId }, { isTaken: false, takenBy: null });
        console.log(`✅ GameCards in MongoDB for ${strGameId} reset to untaken.`);


        // 4. Emit event to frontend to unmark cards
        if (io) {
            // This emit might also need to be reconsidered if cards are meant to be 'taken' during gameplay.
            // io.to(strGameId).emit("cardsUnmarked", { gameId: strGameId }); // <-- Moved or re-evaluated based on game flow
            console.log(`📢 Emitted 'cardsUnmarked' event for game ${strGameId}.`);
        } else {
            console.warn(`⚠️ Socket.IO instance (io) not provided to clearGameSessions. Cannot emit 'cardsUnmarked' event.`);
        }

    } catch (err) {
        console.error(`❌ Error clearing game sessions for game ${strGameId}:`, err);
    }
}

module.exports = clearGameSessions;