const express = require('express');
const router = express.Router();
const User = require("../models/user");
const GameControl = require('../models/GameControl');

// ✅ Game Start Route
router.post("/start", async (req, res) => {
  const { gameId, telegramId } = req.body;

  try {
    const game = await GameControl.findOne({ gameId });

    if (!game) {
      return res.status(404).json({ error: "Game not found." });
    }

    // 🔍 Check if user already joined
    if (!game.players) {
      game.players = []; // In case players array not initialized
    }

    if (game.players.includes(telegramId)) {
      return res.status(400).json({ error: "You already joined this game." });
    }

    // 🔐 Apply Lock (check no transfer in progress + enough balance)
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

    // ✅ Add player to the game
    await GameControl.updateOne(
      { gameId },
      { $addToSet: { players: telegramId } } // Add to players if not exists
    );

    // 🔓 Release lock
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

    // 🛑 Rollback balance & unlock
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
