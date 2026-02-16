const GameControl = require("../models/GameControl");
const { getActiveDrawLockKey, getGameActiveKey } = require("./redisKeys");

// Helper to acquire the game lockS
 async function isGameLockedOrActive(gameId, redis, state) {
        const strGameId = String(gameId);

        // --- 1. Check In-Memory and Redis Locks (Fast Path) ---
        let [redisHasLock, redisIsActive] = await Promise.all([
            redis.get(getActiveDrawLockKey(strGameId)),
            redis.get(getGameActiveKey(strGameId))
        ]);

        if (state.activeDrawLocks[gameId] || redisHasLock === "true" || redisIsActive === "true") {
            return true; // Game is locked.
        }

        // --- 2. Check DB (Source of Truth) ---
        // At this point, no locks were found. Check the database as the final authority.
        const activeGame = await GameControl.findOne({ 
            gameId: strGameId, 
            isActive: true, 
            endedAt: null 
        }).select('_id').lean();

        if (activeGame) {
            // The game IS active in the DB, but Redis is out of sync.
            // Fix Redis for next time and return TRUE.
            console.warn(`[isGameLockedOrActive] Fixed out-of-sync 'gameActive' key for ${strGameId}`);
            await redis.set(getGameActiveKey(strGameId), "true", 'EX', 1800); 
            return true; // ✅ CRITICAL FIX: Return true immediately
        }
        
        // --- 3. Final Result ---
        // Game is not active in memory, Redis, or the DB.
        return false;
    }


    module.exports = { isGameLockedOrActive };