// File: ../utils/resetRound.js
const GameControl = require("../models/GameControl");
const GameCard = require("../models/GameCard");
const { getGameRoomsKey, getGameDrawsKey, getGameDrawStateKey, getActiveDrawLockKey, getGameActiveKey } = require("./redisKeys");

// You might need a UUID generator for a more robust sessionId
// const { v4: uuidv4 } = require('uuid'); // If you install 'uuid' package

async function resetRound(gameId, io, state, redis) {
    const strGameId = String(gameId);
    console.log(`🔄 Resetting round for game: ${strGameId}`);

    // Clear intervals and timeouts for this round
    if (state.countdownIntervals[strGameId]) {
        clearInterval(state.countdownIntervals[strGameId]);
        delete state.countdownIntervals[strGameId];
    }
    if (state.drawIntervals[strGameId]) {
        clearInterval(state.drawIntervals[strGameId]);
        delete state.drawIntervals[strGameId];
    }
    if (state.drawStartTimeouts[strGameId]) {
        clearTimeout(state.drawStartTimeouts[strGameId]);
        delete state.drawStartTimeouts[strGameId];
    }

    // Clear active draw lock
    if (state.activeDrawLocks[strGameId]) {
        delete state.activeDrawLocks[strGameId];
    }

    // Clear Redis keys specific to the current round (including deleting the old gameSessionId)
    await Promise.all([
        redis.set(`gameIsActive:${gameId}`, "false"),
        redis.del(getGameDrawsKey(strGameId)),        // Clear drawn numbers for this round
        redis.del(getGameDrawStateKey(strGameId)),    // Clear drawing state
        redis.del(getActiveDrawLockKey(strGameId)),   // Clear draw lock
        redis.del(getGameRoomsKey(strGameId)),        // Clear active players in the game room
        redis.del(getGameActiveKey(strGameId)),       // Clear game active flag
        redis.del(`gameSessionId:${strGameId}`),      // <--- THIS DELETES THE OLD SESSION ID
    ]);

    // Reset GameCard statuses for this game
    await GameCard.updateMany({ gameId: strGameId }, { isTaken: false, takenBy: null });
    console.log(`✅ GameCards for ${strGameId} reset.`);

    await GameControl.findOneAndUpdate(
        { gameId: strGameId },
        { isActive: false, totalCards: 0, prizeAmount: 0, players: [], endedAt: new Date() }
    );
    console.log(`✅ Game state in DB reset for ${strGameId}.`);

    // Clear in-memory game state for this round
    delete state.gameDraws[strGameId];
    state.gameIsActive[strGameId] = false;
    state.gameReadyToStart[strGameId] = false;
    state.gameSessionIds[strGameId] = null; // This should be consistent with Redis

    // --- CRITICAL ADDITION: GENERATE AND SET NEW SESSION ID FOR THE NEXT ROUND ---
    const newSessionId = `session_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`; // Simple unique ID
    // If you use 'uuid' package: const newSessionId = uuidv4();

    await redis.set(`gameSessionId:${strGameId}`, newSessionId);
    state.gameSessionIds[strGameId] = newSessionId; // Update in-memory state as well
    console.log(`✨ New session ID created and set for game ${strGameId}: ${newSessionId}`);
    // --- END CRITICAL ADDITION ---

    console.log(`🔄 Round reset complete for game: ${strGameId}`);
    // Emit a specific "newRoundReady" or "gameReadyForNextRound" event
    // that includes the new sessionId, so clients can prepare.
    // This is better than "roundEnded" which might just mean the round finished.
    io.to(strGameId).emit("newRoundReady", { gameId: strGameId, sessionId: newSessionId });
}

module.exports = resetRound;