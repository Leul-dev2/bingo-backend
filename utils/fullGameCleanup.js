const { getActiveDrawLockKey } = require("./redisKeys");  
const { syncGameIsActive } = require("./syncGameIsActive");
  
  
async function fullGameCleanup(gameId, redis, state = {}) {
    // Default to empty object so we never crash on undefined state
    console.log("fullGameCleanup 🔥🔥🔥");

    const strGameId = String(gameId);

    // In-memory cleanup — very defensive
    try {
        if (state.countdownIntervals?.[strGameId]) {
            clearInterval(state.countdownIntervals[strGameId]);
            delete state.countdownIntervals[strGameId];
        }
        if (state.drawIntervals?.[strGameId]) {
            clearInterval(state.drawIntervals[strGameId]);
            delete state.drawIntervals[strGameId];
        }
        if (state.activeDrawLocks && strGameId in state.activeDrawLocks) {
            delete state.activeDrawLocks[strGameId];
        }
    } catch (e) {
        console.warn(`Non-fatal cleanup warning for game ${strGameId}:`, e.message);
    }

    // Redis cleanup — always runs
    try {
        await Promise.all([
            redis.del(`lock:countdownOwner:${strGameId}`),
            redis.del(`lock:drawing:${strGameId}`),
            redis.del(`lock:reset:${strGameId}`),
            redis.del(`lock:resetGame:${strGameId}`),
            redis.del(getActiveDrawLockKey(strGameId)),
            // ... other per-game locks if any
        ]);
    } catch (redisErr) {
        console.error(`Redis cleanup failed for ${strGameId}:`, redisErr);
    }

    try {
        await syncGameIsActive(strGameId, false, redis);
    } catch (syncErr) {
        console.error(`syncGameIsActive failed during cleanup for ${strGameId}:`, syncErr);
    }

    console.log(`fullGameCleanup finished for game ${strGameId}`);
}


     module.exports = { fullGameCleanup };