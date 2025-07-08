const GameControl = require("../models/GameControl");
const redis = require("./redisClient");

async function syncGameIsActive(gameId, isActive) {
  try {
    await GameControl.updateOne({ gameId }, { isActive });

    // Cache to Redis with short expiration to allow fast reads
    await redis.set(`gameIsActive:${gameId}`, isActive ? "true" : "false", "EX", 60);
  } catch (err) {
    console.error(`❌ syncGameIsActive error for game ${gameId}:`, err.message);
  }
}

module.exports = syncGameIsActive;
