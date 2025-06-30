const express = require('express');
const router = express.Router();
const User = require("../models/user");
const GameControl = require('../models/GameControl');

// POST /api/games/start
router.post("/start", async (req, res) => {
  const { gameId, telegramId } = req.body;
  const joiningUsers = req.app.get("joiningUsers");

  // 🔐 Lock per game + per user
  const lockKey = `${gameId}:${telegramId}`;

  try {
    // 🧠 Block double clicks or rapid joins
    if (joiningUsers.has(lockKey)) {
      return res.status(429).json({ error: "You're already joining the game. Please wait." });
    }
    joiningUsers.add(lockKey);

    // 🚦 Check if game is active in GameControl
    const game = await GameControl.findOne({ gameId });
    if (game?.isActive) {
      joiningUsers.delete(lockKey);
      return res.status(400).json({ error: "Game is already active." });
    }

    // 💰 Deduct user balance (assuming gameId as price — update if price is separate)
    const user = await User.findOneAndUpdate(
      { telegramId, balance: { $gte: gameId } },
      { $inc: { balance: -gameId } },
      { new: true }
    );

    if (!user) {
      joiningUsers.delete(lockKey);
      return res.status(400).json({ error: "Insufficient balance." });
    }


    // 🔓 Unlock after success
    joiningUsers.delete(lockKey);
    return res.status(200).json({ success: true, gameId, telegramId });

  } catch (err) {
    console.error("Start game error:", err);
    joiningUsers.delete(lockKey);
    return res.status(500).json({ error: "Internal server error" });
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
