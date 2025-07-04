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
    userSelections,
  } = state;
  console.log(`🧹 Starting reset for game ${gameId}`);

  // Reset GameControl in MongoDB
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

  // Notify clients the game has ended
  io?.to(gameId).emit("gameEnded");

  // Clear intervals/timeouts
  if (drawIntervals[gameId]) {
    clearInterval(drawIntervals[gameId]);
    delete drawIntervals[gameId];
    console.log(`🛑 Cleared draw interval for gameId: ${gameId}`);
  }

  if (countdownIntervals[gameId]) {
    clearInterval(countdownIntervals[gameId]);
    delete countdownIntervals[gameId];
  }

  if (drawStartTimeouts[gameId]) {
    clearTimeout(drawStartTimeouts[gameId]);
    delete drawStartTimeouts[gameId];
  }

  // Remove in-memory game state safely
  if (activeDrawLocks) {
    delete activeDrawLocks[gameId];
  }
  if (gameDraws) {
    delete gameDraws[gameId];
  }
  if (gameSessionIds) {
    delete gameSessionIds[gameId];
  }
  if (gameIsActive) {
    delete gameIsActive[gameId];
  }
  if (gamePlayers) {
    delete gamePlayers[gameId];
  }

  // Redis cleanup: remove game sessions, rooms, cards, and userSelections
  try {
    await Promise.all([
      redis.del(`gameSessions:${gameId}`),
      redis.del(`gameRooms:${gameId}`),
      redis.del(`gameCards:${gameId}`),
    ]);

    // Remove all userSelections related to this game
    const pattern = "userSelections:*";
    for await (const key of redis.scanIterator({ MATCH: pattern, COUNT: 100 })) {
      const val = await redis.get(key);
      if (val) {
        try {
          const obj = JSON.parse(val);
          if (obj.gameId === gameId) {
            await redis.del(key);
          }
        } catch {
          // Ignore JSON parse errors
        }
      }
    }

    console.log(`✅ Redis userSelections related to game ${gameId} cleared.`);
  } catch (redisErr) {
    console.error(`❌ Redis cleanup error for game ${gameId}:`, redisErr);
  }

  console.log(`🧼 Game ${gameId} has been fully reset.`);
}

module.exports = resetGame;
