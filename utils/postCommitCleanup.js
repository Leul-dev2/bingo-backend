const { getGameRoomsKey, getGameDrawsKey, getGameDrawStateKey, getActiveDrawLockKey, getGameActiveKey, getGameSessionsKey, getGamePlayersKey, getActivePlayers } = require("./redisKeys");
const PlayerSession = require('../models/PlayerSession'); // ASSUMPTION: You need to import the PlayerSession model
// const getCountdownKey = (gameId) => `countdown:${gameId}`; 

async function postCommitCleanup(gameId, GameSessionId, io, redis, state) {
    const strGameId = String(gameId);
    const strGameSessionId = String(GameSessionId);
    
    // Cleanup server-side state (intervals and timeouts)
    if (state?.countdownIntervals?.[strGameId]) {
        clearInterval(state.countdownIntervals[strGameId]);
        delete state.countdownIntervals[strGameId];
    }
    if (state?.drawIntervals?.[strGameId]) {
        clearInterval(state.drawIntervals[strGameId]);
        delete state.drawIntervals[strGameId];
    }
    if (state?.drawStartTimeouts?.[strGameId]) {
        clearTimeout(state.drawStartTimeouts[strGameId]);
        delete state.drawStartTimeouts[strGameId];
    }
    if (state?.activeDrawLocks?.[strGameId]) {
        delete state.activeDrawLocks[strGameId];
    }
    
    try {
        // --- MONGODB CLEANUP: Delete all PlayerSession records for the finished game ---
        const deleteResult = await PlayerSession.deleteMany({ 
            GameSessionId: strGameSessionId 
        });
        console.log(`✅ MongoDB cleanup: Deleted ${deleteResult.deletedCount} PlayerSession records for session ${strGameSessionId}.`);
        // -------------------------------------------------------------------------------

        // Redis Cleanup
        await Promise.all([
            redis.del(getGameDrawsKey(strGameSessionId)), 
            redis.del(getActivePlayers(strGameSessionId)), 
            redis.del(getGameRoomsKey(strGameId)), 
            redis.del(getActiveDrawLockKey(strGameId)),
            // redis.del(getCountdownKey(strGameId)), // Deleted the countdown key
            redis.del(getGameActiveKey(strGameId)), // Deleted the active game key
            redis.del(getGameDrawStateKey(strGameSessionId)), 
            redis.del(getGameDrawStateKey(strGameId)), 
            redis.del(getGameSessionsKey(strGameId)), 
            redis.del(`gameSessionId:${strGameId}`) 
        ]);
        console.log(`Redis cleanup successful for game ${strGameId}. Keys deleted.`);
    } catch (error) {
        console.error("❌ Cleanup failed during postCommitCleanup:", error);
    }
    

    
    io.to(strGameId).emit("roundEnded", { gameId: strGameId });
    console.log(`Round reset complete and next lobby created for game: ${strGameId}`);
}


module.exports = postCommitCleanup;
