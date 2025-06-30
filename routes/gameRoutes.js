const express = require('express');
const router = express.Router();
const User = require("../models/user");
const GameControl = require('../models/GameControl');

// POST /api/games/start
router.post("/start", async (req, res) => {
  const { gameId, telegramId, price } = req.body;
  const redisClient = req.app.get('redis');

  const lockKey = `joining:${gameId}:${telegramId}`;
  const lockTTL = 10; // Lock expires automatically in 10 seconds as backup

  try {
    // 🔐 Try to set lock
    const isLocked = await redisClient.set(lockKey, 'locked', {
      NX: true, // Only set if not exists
      EX: lockTTL // Auto-expire in 10 seconds
    });

    if (!isLocked) {
      return res.status(429).json({ error: "You're already joining the game. Please wait." });
    }

    // ✅ Atomic balance deduction
    const user = await User.findOneAndUpdate(
      { telegramId, balance: { $gte: price } },
      { $inc: { balance: -price } },
      { new: true }
    );

    if (!user) {
      return res.status(400).json({ error: "Insufficient balance." });
    }

    // 🚦 (Optional) Check game active status
    const game = await GameControl.findOne({ gameId });
    if (game?.isActive) {
      // Optional refund
      await User.findOneAndUpdate(
        { telegramId },
        { $inc: { balance: price } }
      );
      return res.status(400).json({ error: "Game is already active." });
    }

    // 🎯 Success
    return res.status(200).json({ success: true, gameId, telegramId });

  } catch (err) {
    console.error("Start game error:", err);
    return res.status(500).json({ error: "Internal server error" });

  } finally {
    // 🔓 Always release the lock
    await redisClient.del(lockKey);
  }
});

// ✅ Game Status Check
router.get('/:gameId/status', async (req, res) => {
  const { gameId } = req.params;

  try {
    const game = await GameControl.findOne({ gameId });

    if (!game) {
      return res.status(404).json({
        isActive: false,
        message: 'Game not found',
        exists: false
      });
    }

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
