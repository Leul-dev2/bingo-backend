const GameControl = require("../models/GameControl");

const resetGame = async (gameId, io, memoryObjects) => {
  const { drawIntervals, countdownIntervals, gameDraws, gameCards, gameRooms, userSelections, gameSessions, gameIsActive } = memoryObjects;

  try {
    await GameControl.findOneAndUpdate({ gameId }, {
      isActive: false,
      totalCards: 0,
      prizeAmount: 0,
      players: [],
      endedAt: new Date(),
    });

    // Clear intervals & memory
    clearInterval(drawIntervals[gameId]);
    clearInterval(countdownIntervals[gameId]);
    delete drawIntervals[gameId];
    delete countdownIntervals[gameId];
    delete gameDraws[gameId];
    delete gameCards[gameId];
    delete gameRooms[gameId];
    delete gameSessions[gameId];
    delete gameIsActive[gameId];

    // Clean users
    for (const socketId in userSelections) {
      if (userSelections[socketId]?.gameId === gameId) {
        delete userSelections[socketId];
      }
    }

    io.to(gameId).emit("gameEnded");
    console.log(`🧼 Game ${gameId} has been reset`);
  } catch (err) {
    console.error("❌ Failed to reset game:", err.message);
  }
};

module.exports = resetGame;
