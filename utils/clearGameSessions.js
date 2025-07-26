// File: utils/clearGameSessions.js

// Import necessary Redis key getters if they are used elsewhere,
// but for this specific function, we can just use the direct string key
// if getGameSessionsKey is not available or not desired for this very narrow function.
// For consistency, let's assume you'd pass the key from the calling module,
// or use a local string for the key.

async function clearGameSessions(gameId, redis, state) { // <-- ADD 'state' as an argument here
    const strGameId = String(gameId);
    const gameSessionsKey = `gameSessions:${strGameId}`; // This is the Redis key for the card selection lobby

    console.log(`🧹 Attempting to clear only game sessions for game: ${strGameId}`);

    try {
        // 1. Clear the Redis key for game sessions
        const deletedCount = await redis.del(gameSessionsKey);

        if (deletedCount > 0) {
            console.log(`✅ Redis game sessions (key: ${gameSessionsKey}) cleared.`);
        } else {
            console.log(`ℹ️ Redis game sessions (key: ${gameSessionsKey}) did not exist or was already empty.`);
        }

        // 2. Clear the corresponding in-memory state variable
        // This is safe to do IF 'state' is guaranteed to be passed and defined.
        if (state && state.gameSessionIds?.[strGameId]) {
            delete state.gameSessionIds[strGameId];
            console.log(`✅ In-memory gameSessionIds for ${strGameId} cleared.`);
        } else {
            console.log(`ℹ️ No in-memory gameSessionIds found for ${strGameId} to clear.`);
        }

    } catch (err) {
        console.error(`❌ Error clearing game sessions for game ${strGameId}:`, err);
    }
}

module.exports = clearGameSessions;