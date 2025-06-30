const express = require('express');
const router = express.Router();
const User = require("../models/user");
const GameControl = require('../models/GameControl');

// ✅ Game Start Route with Mongo Locking
router.post("/start", async (req, res) => {
  const { gameId, telegramId } = req.body;
  const price = gameId; // Replace this with actual price if needed

  try {
    // 🔐 Step 1: Attempt to set a lock atomically AND check balance
    const user = await User.findOneAndUpdate(
      { 
        telegramId, 
        transferInProgress: null, 
        balance: { $gte: price }
      },
      { 
        $set: { transferInProgress: { type: 'gameStart', at: Date.now() } },
        $inc: { balance: -price }
      },
      { new: true }
    );

    if (!user) {
      return res.status(400).json({ 
        error: "Either another transaction is in progress or insufficient balance." 
      });
    }

    // 🔥 Step 2: Check Game Status (optional if managed by socket separately)
    const game = await GameControl.findOne({ gameId });

    if (game?.isActive) {
      // Refund since game is active
      await User.updateOne(
        { telegramId },
        { 
          $inc: { balance: price }, 
          $set: { transferInProgress: null }
        }
      );

      return res.status(400).json({ error: "Game is already active." });
    }

    // ✅ Step 3: Success — Release the lock
    await User.updateOne(
      { telegramId },
      // { $set: { transferInProgress: null } }
    );

    return res.status(200).json({ success: true, gameId, telegramId });

  } catch (error) {
    console.error("🔥 Game Start Error:", error);

    // 🔓 Step 4: Always release the lock on failure
    await User.updateOne(
      { telegramId },
      { $set: { transferInProgress: null } }
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
