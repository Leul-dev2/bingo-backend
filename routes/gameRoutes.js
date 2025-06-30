const express = require('express');
const router = express.Router();
const User = require("../models/user");
const GameControl = require('../models/GameControl');

// Shared memory (outside route, initialized once)
//const joiningUsers = new Set();

// POST /api/games/start
router.post("/start", async (req, res) => {
  const { gameId, telegramId } = req.body;
  const joiningUsers = req.app.get("joiningUsers");

  try {
    // 🔐 Lock FIRST to prevent race conditions
    if (joiningUsers.has(telegramId)) {
      return res.status(429).json({ error: "You are already joining the game. Please wait." });
    }
    joiningUsers.add(telegramId);

    // 🚩 Check if game is already active
    const game = await GameControl.findOne({ gameId });
    if (game?.isActive) {
      joiningUsers.delete(telegramId);
      return res.status(400).json({ error: "Game is already active." });
    }

    // 💰 Deduct balance
    const user = await User.findOneAndUpdate(
      { telegramId, balance: { $gte: gameId } }, // Assuming gameId is the price
      { $inc: { balance: -gameId } },
      { new: true }
    );

    if (!user) {
      joiningUsers.delete(telegramId);
      return res.status(400).json({ error: "Insufficient balance." });
    }

    // ✅ Mark game as active
    await GameControl.updateOne(
      { gameId },
      { $set: { isActive: true } },
      { upsert: true }
    );

    // ✅ Success response
    joiningUsers.delete(telegramId);
    return res.status(200).json({ success: true, gameId, telegramId });

  } catch (error) {
    console.error("Start game error:", error);
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
      return res.status(404).json({ isActive: false, message: 'Game not found', exists: false });
    }

    return res.json({ isActive: game.isActive, exists: true });

  } catch (error) {
    console.error("Status check error:", error);
    return res.status(500).json({ isActive: false, message: 'Server error', exists: false });
  }
});

module.exports = router;
