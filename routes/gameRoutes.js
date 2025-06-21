const express = require('express');
const router = express.Router();

// Assume these are initialized and passed from main app.js
const User = require("../models/user");
const GameControl = require('../models/GameControl');

// Global lock to prevent rapid double joins
const joiningUsers = new Set();

// POST /api/games/start
router.post("/start", async (req, res) => {
  const { gameId, telegramId } = req.body;

  try {
    // Prevent double join
    if (joiningUsers.has(telegramId)) {
      return res.status(429).json({ error: "You're already joining the game" });
    }

    joiningUsers.add(telegramId);

    // 🔍 Check if game is already active
    const game = await GameControl.findOne({ gameId });
    if (game?.isActive) {
      joiningUsers.delete(telegramId);
      return res.status(409).json({ error: "Game already active" });
    }

    // 💰 Deduct balance if enough
    const user = await User.findOneAndUpdate(
      { telegramId, balance: { $gte: gameId } },
      { $inc: { balance: -gameId } },
      { new: true }
    );

    if (!user) {
      joiningUsers.delete(telegramId);
      return res.status(400).json({ error: "Insufficient balance" });
    }

    // ✅ Optionally mark game as active here (only for first player)
    if (!game?.isActive) {
      await GameControl.updateOne(
        { gameId },
        { $set: { isActive: true } },
        { upsert: true }
      );
    }

    joiningUsers.delete(telegramId);
    return res.status(200).json({ success: true, gameId, telegramId });

  } catch (err) {
    console.error("Start error:", err);
    joiningUsers.delete(telegramId);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// GET /api/games/:gameId/status
router.get('/:gameId/status', async (req, res) => {
  const { gameId } = req.params;

  try {
    const game = await GameControl.findOne({ gameId });

    if (!game) {
      return res.status(404).json({ isActive: false, message: 'Game not found' });
    }

    res.json({ isActive: game.isActive });
  } catch (error) {
    console.error(error);
    res.status(500).json({ isActive: false, message: 'Server error' });
  }
});

module.exports = router;
