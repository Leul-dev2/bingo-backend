const express = require('express');
const router = express.Router();
const User = require("../models/user");
const GameControl = require('../models/GameControl');
const redis = require("../utils/redisClient"); // Your Redis client import

router.post("/start", async (req, res) => {
  const { gameId, telegramId } = req.body;

  let game;

  try {
    game = await GameControl.findOne({ gameId });
    if (!game) {
      return res.status(404).json({ error: "Game not found." });
    }

    const isMember = await redis.sIsMember(`gameRooms:${gameId}`, telegramId);
    if (isMember) {
      return res.status(400).json({ error: "You already joined this game." });
    }

    const user = await User.findOneAndUpdate(
      {
        telegramId,
        transferInProgress: null,
        balance: { $gte: game.stakeAmount },
      },
      {
        $set: { transferInProgress: { type: "gameStart", at: Date.now() } },
        $inc: { balance: -game.stakeAmount },
      },
      { new: true }
    );

    if (!user) {
      return res.status(400).json({
        error: "Insufficient balance or transaction already in progress.",
      });
    }

    // ✅ Immediately sync balance to Redis cache
    await redis.set(`userBalance:${telegramId}`, user.balance.toString(), "EX", 60);

    // ✅ Update players list in MongoDB
    await GameControl.updateOne(
      { gameId },
      { $addToSet: { players: telegramId } }
    );

    // ✅ Add to Redis set for real-time checks
    await redis.sAdd(`gameRooms:${gameId}`, telegramId);

    // ✅ Release the user lock
    await User.updateOne(
      { telegramId },
      { $set: { transferInProgress: null } }
    );

    return res.status(200).json({
      success: true,
      gameId,
      telegramId,
      message: "Joined game successfully.",
    });

  } catch (error) {
    console.error("🔥 Game Start Error:", error);

    if (game) {
      await User.updateOne(
        { telegramId },
        {
          $inc: { balance: game.stakeAmount || 0 },
          $set: { transferInProgress: null },
        }
      );
    } else {
      await User.updateOne(
        { telegramId },
        { $set: { transferInProgress: null } }
      );
    }

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
