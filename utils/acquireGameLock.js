 const { getActiveDrawLockKey } = require("./redisKeys");
 
 async function acquireGameLock(gameId, redis, state) {
        const lockKey = getActiveDrawLockKey(gameId);
        
        // Attempt to set the lock ONLY IF IT DOES NOT EXIST (NX)
        // and give it an expiration time (EX) of 300 seconds (5 minutes)
        const lockAcquired = await redis.set(lockKey, 'true', 'NX', 'EX', 300);

        if (lockAcquired) {
            // Only update in-memory state if Redis lock was successfully acquired
            state.activeDrawLocks[gameId] = true;
            return true; // Lock secured
        }
        
        // If lockAcquired is null, the lock already existed.
        return false; // Lock failed to secure
    }

    module.exports = { acquireGameLock };