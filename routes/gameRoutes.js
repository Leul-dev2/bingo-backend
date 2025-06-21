const express = require('express');
const router = express.Router();
const User = require("../models/user");
const GameControl = require('../models/GameControl'); // Your game model

const joiningUsers = new Set(); // In-memory lock to block rapid duplicate joins
// const manualStartOnly = {}; // global state map


// routes/start.js
router.post("/start", async (req, res) => {
  const { gameId, telegramId } = req.body;

  const joiningUsers = req.app.get("joiningUsers");
  const User = req.app.get("User");

  try {
    if (joiningUsers.has(telegramId)) {
      return res.status(429).json({ error: "You're already joining the game" });
    }

    // // if (manualStartOnly[gameId]) {
    // //   delete manualStartOnly[gameId];
    //   console.log(`✅ Game ${gameId} manually unlocked via API /start`);
    // // }s

    joiningUsers.add(telegramId);

    const user = await User.findOneAndUpdate(
      { telegramId, balance: { $gte: gameId } },
      { $inc: { balance: -gameId } },
      { new: true }
    );

    if (!user) {
      joiningUsers.delete(telegramId);
      return res.status(400).json({ error: "Insufficient balance" });
    }

    joiningUsers.delete(telegramId);
    return res.status(200).json({ success: true, gameId, telegramId });

  } catch (err) {
    joiningUsers.delete(telegramId);
    return res.status(500).json({ error: "Internal server error" });
  }
});


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
