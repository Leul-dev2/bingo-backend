const express = require('express');
const router = express.Router();
const User = require("../models/user");
const GameControl = require('../models/GameControl');
const GameCard = require("../models/GameCard");
const redis = require("../utils/redisClient");
const { v4: uuidv4 } = require('uuid');

// --- IMPORTANT: Define these default values before your router.post block ---
const DEFAULT_GAME_TOTAL_CARDS = 1;
const FALLBACK_STAKE_AMOUNT = 10;
const DEFAULT_CREATED_BY = 'System';
const DEFAULT_IS_ACTIVE = false;




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
