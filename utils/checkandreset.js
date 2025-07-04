const resetGame = require("./resetGame");
const GameControl = require("../models/GameControl");

async function checkAndResetIfEmpty(gameId, io, gameRooms) {
  const roomSize = gameRooms[gameId]?.size ?? 0;

  console.log("room size", roomSize);

  if (roomSize === 0) {
    console.log(`🧹 No players left in game ${gameId}. Resetting game...`);
    await resetGame(gameId, io);

    try {
      await GameControl.findOneAndUpdate(
        { gameId },
        { isActive: false }
      );
    } catch (err) {
      console.error("❌ Error updating game status:", err);
    }

    io.to(gameId).emit("gameEnded");
    return true;
  } else {
    console.log(`🟢 Game ${gameId} continues with ${roomSize} players.`);
    return false;
  }
}

module.exports = checkAndResetIfEmpty;
