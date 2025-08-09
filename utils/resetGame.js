const GameControl = require("../models/GameControl");

async function resetGame(gameId, io, state, redis) {
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
        await GameControl.findOneAndUpdate(
            { gameId: gameId.toString() },
            {
                isActive: false,
                endedAt: new Date(),
            }
        );
        console.log(`✅ GameControl for game ${gameId} has been reset in DB.`);
    } catch (err) {
        console.error(`❌ Failed to reset GameControl for ${gameId}:`, err);
    }

    // 📢 2. Notify clients
    io?.to(gameId).emit("gameEnded");


    // ⏱ 3. Clear timeouts/intervals
    if (drawIntervals?.[gameId]) {
        clearInterval(drawIntervals[gameId]);
        delete drawIntervals[gameId];
        console.log(`🛑 Cleared draw interval for gameId: ${gameId}`);
    }

    if (countdownIntervals?.[gameId]) {
        clearInterval(countdownIntervals[gameId]);
        delete countdownIntervals[gameId];
        console.log(`🛑 Cleared countdown interval for gameId: ${gameId}`);
    }

    if (drawStartTimeouts?.[gameId]) {
        clearTimeout(drawStartTimeouts[gameId]);
        delete drawStartTimeouts[gameId];
        console.log(`🛑 Cleared draw start timeout for gameId: ${gameId}`);
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
            redis.del(`gameSessions:${gameId}`),
            redis.del(`gameRooms:${gameId}`),
            redis.del(`gameCards:${gameId}`),
            redis.del(`gamePlayers:${gameId}`), // Confirmed: Delete the master player set
            redis.del(`gameIsActive:${gameId}`), // Optional: if stored
            redis.del(`gameActive:${gameId}`),   // Optional: if stored
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