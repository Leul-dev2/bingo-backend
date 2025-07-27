// File: ../utils/resetRound.js
const GameControl = require("../models/GameControl");
const GameCard = require("../models/GameCard");
const { getGameRoomsKey, getGameDrawsKey, getGameDrawStateKey, getActiveDrawLockKey, getGameActiveKey } = require("./redisKeys"); // Assume redisKeys.js is updated with all helper functions

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

    // Clear Redis keys specific to the current round
    await Promise.all([
        redis.set(`gameIsActive:${gameId}`, "false"),
        redis.del(getGameDrawsKey(strGameId)),        // Clear drawn numbers for this round
        redis.del(getGameDrawStateKey(strGameId)),    // Clear drawing state
        redis.del(getActiveDrawLockKey(strGameId)),   // Clear draw lock
        redis.del(getGameRoomsKey(strGameId)), 
        redis.del(getGameActiveKey(strGameId)),        // Clear active players in the game room
        redis.del(`gameSessionId:${strGameId}`), 
    ]);

    // Reset GameCard statuses for this game
    await GameCard.updateMany({ gameId: strGameId }, { isTaken: false, takenBy: null });
    console.log(`✅ GameCards for ${strGameId} reset.`);
     await GameControl.findOneAndUpdate(
                    { gameId: strGameId },
                    { isActive: false, totalCards: 0, prizeAmount: 0, players: [], endedAt: new Date() }
    );
    console.log(`✅ Game is ready for game play `);

    // Clear in-memory game state for this round
    delete state.gameDraws[strGameId];
    // Note: state.gameSessionIds[strGameId] is NOT cleared here as per "gameroom only" reset
    // Note: state.gameIsActive[strGameId] is NOT cleared here, handled by GameControl DB if it means overall game
    // Note: state.gameReadyToStart[strGameId] is NOT cleared here

    state.gameIsActive[strGameId] = false;
    state.gameReadyToStart[strGameId] = false;
    state.gameSessionIds[strGameId] = null;

    console.log(`🔄 Round reset complete for game: ${strGameId}`);
    io.to(strGameId).emit("roundEnded", { gameId: strGameId }); // Emit specific round ended event
}

module.exports = resetRound;