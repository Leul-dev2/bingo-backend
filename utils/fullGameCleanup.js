const { getActiveDrawLockKey } = require("./redisKeys");  
const { syncGameIsActive } = require("./syncGameIsActive");
  
  
  async function fullGameCleanup(gameId, redis, state) {
        console.log("fullGameCleanup 🔥🔥🔥");
        delete state.activeDrawLocks[gameId];
        await redis.del(getActiveDrawLockKey(gameId));
        await syncGameIsActive(gameId, false, redis);
        if (state.countdownIntervals[gameId]) { clearInterval(state.countdownIntervals[gameId]); delete state.countdownIntervals[gameId]; }
     }


     module.exports = { fullGameCleanup };