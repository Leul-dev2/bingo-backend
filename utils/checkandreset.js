// checkandreset.js
const resetGame = require("./resetGame");
const GameControl = require("../models/GameControl");

async function checkAndResetIfEmpty(gameId, io, redis, state) {
  const roomSize = await redis.sCard(`gameRooms:${gameId}`);

  console.log("room size", roomSize);

  if (!roomSize || roomSize === 0) {
    console.log(`🧹 No players left in game ${gameId}. Resetting game...`);

    // Reset DB first
    try {
      await GameControl.findOneAndUpdate(
        { gameId },
        { isActive: false, totalCards: 0, prizeAmount: 0, players: [], endedAt: new Date() }
      );
      console.log(`✅ GameControl for game ${gameId} has been reset in DB.`);
    } catch (err) {
      console.error("❌ Error updating game status:", err);
    }

    // Reset Redis and memory
    await resetGame(gameId, io, state, redis);

    io.to(gameId).emit("gameEnded");
    return true;
  } else {
    console.log(`🟢 Game ${gameId} continues with ${roomSize} players.`);
    return false;
  }
}

module.exports = checkAndResetIfEmpty;
