const GameControl = require("../models/GameControl");
const { getGameRoomsKey, getGameDrawsKey, getGameDrawStateKey, getActiveDrawLockKey, getGameActiveKey, getGameSessionsKey, getGamePlayersKey } = require("./redisKeys");

async function resetGame(gameId, strGameSessionId,  io,  state, redis) {
    const strGameId = String(gameId);
    console.log("inside reset Game gamesessionid🤪🤪", strGameSessionId);
    const {
        drawIntervals,
        countdownIntervals,
        drawStartTimeouts,
        activeDrawLocks,
        gameDraws,
        gameSessionIds,
        gameIsActive,
        gamePlayers,
        userSelections, // Not used here for Redis cleanup, as handled elsewhere or removed
    } = state;

    console.log(`🧹 Starting full reset for game ${gameId}`);

    // 🛠 1. Update GameControl in MongoDB
    try {
        const updatedGame = await GameControl.findOneAndUpdate(
                { GameSessionId: strGameSessionId },
                { $set: { isActive: false, endedAt: new Date() } },
                { new: true }
            );
            console.log("Updated GameControl:", updatedGame);
        console.log(`✅ GameControl for game ${gameId} has been reset in DB.`);
    } catch (err) {
        console.error(`❌ Failed to reset GameControl for ${gameId}:`, err);
    }

    // 📢 2. Notify clients
    io?.to(gameId).emit("gameEnded");


    // ⏱ 3. Clear timeouts/intervals
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

    // 🧠 4. Clear in-memory state
    delete activeDrawLocks?.[gameId];
    delete gameDraws?.[gameId];
    delete gameSessionIds?.[gameId];
    delete gameIsActive?.[gameId];
    delete gamePlayers?.[gameId]; // Clear this in-memory map/object entry
    console.log(`🧹 In-memory state for game ${gameId} cleared.`);


    // 🗑️ 5. Redis cleanup for game-specific keys
    try {
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
    ]);
        console.log(`✅ Core Redis game keys for ${gameId} cleared.`);

        // --- IMPORTANT NOTE ON USER SELECTIONS CLEANUP ---
        // The `userSelectionsByTelegramId` hash (keyed by Telegram ID)
        // is primarily cleaned up in the `socket.on("disconnect")` handler
        // when a user truly leaves the game.
        // Clearing it here for a specific gameId would require iterating through
        // the entire `userSelectionsByTelegramId` hash, which is generally inefficient
        // for a global hash and less critical given the disconnect handler's role.
        // If `userSelections` (keyed by socket.id) is a global hash, it also shouldn't
        // be fully deleted here as it might contain data for other active games.
        // It's best to rely on the `disconnect` logic for user-specific cleanup.
        // --- END NOTE ---

    } catch (redisErr) {
        console.error(`❌ Redis cleanup error for game ${gameId}:`, redisErr);
    }

    console.log(`🧼 Game ${gameId} has been fully reset.`);
}

module.exports = resetGame;