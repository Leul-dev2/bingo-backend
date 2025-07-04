const express = require('express');
const router = express.Router();
const User = require("../models/user");
const GameControl = require('../models/GameControl');
const redis = require("../utils/redisClient"); // Your Redis client import

router.post("/start", async (req, res) => {
  const { gameId, telegramId } = req.body;

  try {
    // Check if game exists
    const game = await GameControl.findOne({ gameId });
    if (!game) {
      return res.status(404).json({ error: "Game not found." });
    }

    // Check Redis if player already joined
    const isMember = await redis.sismember(`gameRooms:${gameId}`, telegramId);
    if (isMember) {
      return res.status(400).json({ error: "You already joined this game." });
    }

    // Lock and balance check in MongoDB
    const user = await User.findOneAndUpdate(
      {
        telegramId,
        transferInProgress: null,
        balance: { $gte: game.stakeAmount }
      },
      {
        $set: { transferInProgress: { type: 'gameStart', at: Date.now() } },
        $inc: { balance: -game.stakeAmount }
      },
      { new: true }
    );

    if (!user) {
      return res.status(400).json({ 
        error: "Insufficient balance or transaction already in progress." 
      });
    }

    // Add player to MongoDB players array (if needed)
    await GameControl.updateOne(
      { gameId },
      { $addToSet: { players: telegramId } }
    );

    // Add player to Redis set for quick membership checks and real-time tracking
    await redis.sadd(`gameRooms:${gameId}`, telegramId);

    // Release lock on user
    await User.updateOne(
      { telegramId },
      { $set: { transferInProgress: null } }
    );

    return res.status(200).json({ 
      success: true, 
      gameId, 
      telegramId, 
      message: "Joined game successfully."
    });

  } catch (error) {
    console.error("🔥 Game Start Error:", error);

    // Rollback user balance & unlock on error
    await User.updateOne(
      { telegramId },
      {
        $inc: { balance: game?.stakeAmount || 0 },
        $set: { transferInProgress: null }
      }
    );

    return res.status(500).json({ error: "Internal server error." });
  }
});


// ✅ Game Status Check
router.get('/:gameId/status', async (req, res) => {
  const { gameId } = req.params;

  try {
    // Check Redis first for isActive flag (faster than DB)
    const isActiveStr = await redis.get(`gameIsActive:${gameId}`);

    if (isActiveStr !== null) {
      return res.json({
        isActive: isActiveStr === 'true',
        exists: true
      });
    }

    // Fall back to DB if Redis cache miss
    const game = await GameControl.findOne({ gameId });

    if (!game) {
      return res.status(404).json({
        isActive: false,
        message: 'Game not found',
        exists: false
      });
    }

    // Optionally update Redis cache for future calls (expire after 60s or so)
    await redis.set(`gameIsActive:${gameId}`, game.isActive ? 'true' : 'false', 'EX', 60);

    return res.json({
      isActive: game.isActive,
      exists: true
    });

  } catch (error) {
    console.error("Status check error:", error);
    return res.status(500).json({
      isActive: false,
      message: 'Server error',
      exists: false
    });
  }
});


module.exports = router;
