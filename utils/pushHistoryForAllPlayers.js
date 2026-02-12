// utils/pushHistoryForAllPlayers.js
const Ledger = require("../models/Ledger");

/**
 * Queues a single job to process all players' history for a session.
 * Prevents duplicate jobs using a Redis lock.
 * 
 * @param {string} strGameSessionId - The game session ID
 * @param {string} strGameId - The game ID
 * @param {object} redis - Redis client instance
 */
async function pushHistoryForAllPlayers(strGameSessionId, strGameId, redis) {
    if (!strGameSessionId || !strGameId) {
        console.warn(`⚠️ Missing gameSessionId or gameId. Skipping history push.`);
        return;
    }

    const lockKey = `historyQueued:${strGameSessionId}`;

    // Attempt to set a Redis key for this session (NX = only if not exists, EX = expire in 10 min)
    const lockAcquired = await redis.set(lockKey, "1", { NX: true, EX: 600 });
    if (!lockAcquired) {
        console.log(`⚠️ History already queued for session ${strGameSessionId}. Skipping push.`);
        return;
    }

    console.log(`🔍🚀 Queuing history for session ${strGameSessionId}...`);

    // Single job for the entire session
    const historyJob = {
        type: 'PROCESS_GAME_HISTORY',
        strGameSessionId,
        strGameId,
        firedAt: new Date()
    };

    await redis.lPush('game-task-queue', JSON.stringify(historyJob));
    console.log(`✅ History job queued for session ${strGameSessionId}`);
}

module.exports = pushHistoryForAllPlayers;
