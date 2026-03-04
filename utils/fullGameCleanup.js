const { getActiveDrawLockKey } = require("./redisKeys");  
const { syncGameIsActive } = require("./syncGameIsActive");
  
  
  async function fullGameCleanup(gameId, redis, state) {
        console.log("fullGameCleanup 🔥🔥🔥");
         
    await redis.del(`lock:resetGame:${gameId}`);
    await redis.del(`lock:reset:${gameId}`);
    await redis.del(`lock:countdownOwner:${gameId}`);
    await redis.del(`lock:drawing:${gameId}`);

        delete state.activeDrawLocks[gameId];
        await redis.del(getActiveDrawLockKey(gameId));
        await syncGameIsActive(gameId, false, redis);
        if (state.countdownIntervals[gameId]) { clearInterval(state.countdownIntervals[gameId]); delete state.countdownIntervals[gameId]; }
     }


     module.exports = { fullGameCleanup };