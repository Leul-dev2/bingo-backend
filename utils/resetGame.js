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
    userSelections, // Not used here, but keep for consistency
  } = state;

  console.log(`🧹 Starting reset for game ${gameId}`);

  // 🛠 1. Update GameControl in MongoDB
  try {
    await GameControl.findOneAndUpdate(
      { gameId: gameId.toString() },
      {
        isActive: false,
        totalCards: 0,
        prizeAmount: 0,
        players: [],
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
  }

  if (drawStartTimeouts?.[gameId]) {
    clearTimeout(drawStartTimeouts[gameId]);
    delete drawStartTimeouts[gameId];
  }

  // 🧠 4. Clear in-memory state
  delete activeDrawLocks?.[gameId];
  delete gameDraws?.[gameId];
  delete gameSessionIds?.[gameId];
  delete gameIsActive?.[gameId];
  delete gamePlayers?.[gameId];

  // 🗑️ 5. Redis cleanup
  try {
    await Promise.all([
      redis.del(`gameSessions:${gameId}`),
      redis.del(`gameRooms:${gameId}`),
      redis.del(`gameCards:${gameId}`),
      redis.del(`gameIsActive:${gameId}`), // optional: if stored
    ]);

    // ✅ 6. Delete userSelections related to this gameId
    const pattern = "userSelections:*";
    const keysToDelete = [];

    for await (const key of redis.scanIterator({ MATCH: pattern, COUNT: 100 })) {
      if (typeof key !== "string") continue;
      const val = await redis.get(key);
      if (!val) continue;

      try {
        const obj = JSON.parse(val);
        if (obj?.gameId?.toString() === gameId.toString()) {
          keysToDelete.push(key);
        }
      } catch (err) {
        // Ignore invalid JSON
      }
    }

    if (keysToDelete.length > 0) {
      await redis.del(...keysToDelete);
      console.log(`✅ Redis userSelections related to game ${gameId} cleared.`);
    } else {
      console.log(`ℹ️ No Redis userSelections found for game ${gameId}.`);
    }

  } catch (redisErr) {
    console.error(`❌ Redis cleanup error for game ${gameId}:`, redisErr);
  }

  console.log(`🧼 Game ${gameId} has been fully reset.`);
}

module.exports = resetGame;
