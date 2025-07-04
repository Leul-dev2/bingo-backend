const GameControl = require("../models/GameControl");

async function resetGame(gameId, io) {
  console.log(`🧹 Starting reset for game ${gameId}`);

  // 🔥 Reset GameControl in MongoDB
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

  // 🔥 Notify clients the game has ended
  io?.to(gameId).emit("gameEnded");

  // ✅ Clear drawing interval
  if (drawIntervals[gameId]) {
    clearInterval(drawIntervals[gameId]);
    delete drawIntervals[gameId];
    console.log(`🛑 Cleared draw interval for gameId: ${gameId}`);
  }

  // ✅ Clear countdown interval
  if (countdownIntervals[gameId]) {
    clearInterval(countdownIntervals[gameId]);
    delete countdownIntervals[gameId];
  }

  // ✅ Clear pending draw start
  if (drawStartTimeouts[gameId]) {
    clearTimeout(drawStartTimeouts[gameId]);
    delete drawStartTimeouts[gameId];
  }

  // ✅ Remove in-memory game state
  delete activeDrawLocks[gameId];
  delete gameDraws[gameId];
  delete gameCards[gameId];
  delete gameSessionIds[gameId];
  delete gameSessions[gameId];
  delete gameRooms[gameId];
  delete gameIsActive[gameId];
  delete gamePlayers[gameId];

  // ✅ Remove user selections for this game
  for (let socketId in userSelections) {
    if (userSelections[socketId]?.gameId === gameId) {
      delete userSelections[socketId];
    }
  }

  console.log(`🧼 Game ${gameId} has been fully reset.`);
}

module.exports = resetGame;
