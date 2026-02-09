// File: ../utils/resetRound.js
const GameControl = require("../models/GameControl");
const GameCard = require("../models/GameCard");
const { getGameRoomsKey, getGameDrawsKey, getGameDrawStateKey, getActiveDrawLockKey, getGameActiveKey, getGameSessionsKey, getGamePlayersKey, getActivePlayers } = require("./redisKeys");

async function resetRound(gameId, GameSessionId, socket, io, state, redis) {
    const strGameId = String(gameId);
    const strGameSessionId = String(GameSessionId);
    console.log(`🔄 Resetting round for game: ${strGameId}`);

    // Clear intervals and timeouts for this round
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

    // Clear Redis keys specific to the current round
    await Promise.all([
        redis.set(`gameIsActive:${gameId}`, "false"),
        redis.del(getGameDrawsKey(GameSessionId)),
        redis.del(getGameDrawStateKey(strGameId)),
        redis.del(getGameDrawsKey(strGameSessionId)),
        redis.del(getActiveDrawLockKey(strGameId)),
        redis.del(getGameSessionsKey(strGameId)),
        redis.del(getGameRoomsKey(strGameId)),
        redis.del(getGameActiveKey(strGameId)),
        redis.del(`gameSessionId:${strGameId}`),
        redis.del(getActivePlayers(strGameSessionId))
    ]);

    // 🏆 FIX: Only reset cards that were part of the game session 🏆
    await GameCard.updateMany(
        { gameId: strGameId, GameSessionId: strGameSessionId },
        { isTaken: false, takenBy: null, GameSessionId: null }
    );
    console.log(`✅ GameCards for session ${strGameSessionId} reset.`);

    console.log("Searching for GameControl with GameSessionId:", strGameSessionId);
    const updatedGame = await GameControl.findOneAndUpdate(
        { GameSessionId: strGameSessionId },
        { $set: { isActive: false, endedAt: new Date() } },
        { new: true }
    );
    console.log("Updated GameControl:", updatedGame);

    console.log(`✅ Game is ready for game play `);

    // --- Clear user selections for the specific gameId ---
    const userSelections = await redis.hGetAll("userSelectionsByTelegramId");
    const telegramIdsToDelete = [];

    for (const telegramId in userSelections) {
        try {
            const selectionData = JSON.parse(userSelections[telegramId]);
            if (selectionData.gameId === strGameId) {
                telegramIdsToDelete.push(telegramId);
            }
        } catch (error) {
            console.error(`Error parsing user selection for Telegram ID ${telegramId}:`, error);
        }
    }

    if (telegramIdsToDelete.length > 0) {
        await redis.hDel("userSelectionsByTelegramId", ...telegramIdsToDelete);
        console.log(`🗑️ Deleted ${telegramIdsToDelete.length} user selections for game ${strGameId}.`);
    } else {
        console.log(`No user selections found for game ${strGameId} to delete.`);
    }

    // Clear in-memory game state for this round
    delete state.gameDraws[strGameId];
    state.gameIsActive[strGameId] = false;
    state.gameReadyToStart[strGameId] = false;
    state.gameSessionIds[strGameId] = null;

    console.log(`🔄 Round reset complete for game: ${strGameId}`);
    io.to(strGameId).emit("roundEnded", { gameId: strGameId });
    // socket.emit("gameEnd");
    console.log("📖📖 game End is emitted");
}

module.exports = resetRound;