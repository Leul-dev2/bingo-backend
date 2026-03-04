// resetRound.js  ← FULL PRODUCTION-READY VERSION

const { getGameDrawStateKey, getGameDrawsKey } = require("./redisKeys");
const { fullGameCleanup } = require("./fullGameCleanup");
const GameControl = require("../models/GameControl");
const { pushHistoryForAllPlayers } = require("./pushHistoryForAllPlayers");

async function resetRound(gameId, GameSessionId, socket, io, state, redis) {
    const strGameId = String(gameId);
    const strGameSessionId = String(GameSessionId);
     console.log(`🔄 Resetting round for game: ${strGameId}`);
     await pushHistoryForAllPlayers(strGameSessionId, strGameId, redis);

    // ── Redis lock to prevent multiple servers from resetting the same game ──
    const resetLockKey = `lock:reset:${strGameId}`;
    const lockAcquired = await redis.set(resetLockKey, "1", { NX: true, EX: 15 });
    if (!lockAcquired) {
        console.log(`⛔️ Reset already owned by another process for game ${strGameId}. Skipping.`);
        return;
    }

    try {
        console.log(`🔄 Starting round reset for game ${strGameId}`);

        // 1. Mark game as ended in MongoDB (safe, outside any transaction)
       await GameControl.findOneAndUpdate(
        { GameSessionId: strGameSessionId },
        { $set: { isActive: false, endedAt: new Date() } },
        { new: true }
       );
        console.log(`✅ Game ${strGameId} marked as ended in DB`);

        // 2. Clear all drawing-related Redis keys
        await Promise.all([
            redis.del(getGameDrawStateKey(strGameSessionId)),
            redis.del(getGameDrawsKey(strGameSessionId)),
        ]);
        console.log(`🧹 Cleared draw state and draws for game ${strGameId}`);

        // 3. Clear any remaining drawing interval (defense in depth)
        if (state.drawIntervals[strGameId]) {
            clearInterval(state.drawIntervals[strGameId]);
            delete state.drawIntervals[strGameId];
            console.log(`⏹️ Cleared draw interval for game ${strGameId}`);
        }

        // 4. Full cleanup (includes countdownOwner, drawing lock, activeDrawLocks, etc.)
        await fullGameCleanup(strGameId, redis, state);

        // 5. Notify ALL clients (matches your frontend handleGameReset)
        io.to(strGameId).emit("gameReset", { gameId: strGameId });
        console.log(`📢 Emitted gameReset to room ${strGameId} — lobby is now ready for next gameCount`);

    } catch (error) {
        console.error(`❌ Error during resetRound for game ${strGameId}:`, error);
        // Still try to clean up even on error
        await fullGameCleanup(strGameId, redis, state);
    } finally {
        // Always release the reset lock
        await redis.del(resetLockKey);
    }
}

module.exports = { resetRound };