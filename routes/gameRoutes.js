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

router.post("/start", async (req, res) => {
    const { gameId, telegramId, cardId } = req.body;
    let currentSessionId;
    let game;
    
    // --- Step 1: ACQUIRE LOCK ---
    const lockKey = `startLock:${telegramId}:${gameId}`;
    const lockAcquired = await redis.set(lockKey, 'locked', 'EX', 5, 'NX');

    if (!lockAcquired) {
        return res.status(429).json({ error: "A game start request is already being processed. Please wait a moment." });
    }

    try {
        // Step 2: Check for an ACTIVE game session. This is the ONLY condition to block a player.
        const activeGame = await GameControl.findOne({ gameId, isActive: true, endedAt: null });
        if (activeGame) {
            // A game is in progress, so block the request.
            return res.status(400).json({ error: "A game is currently in progress. Please wait for the next round." });
        }

        // Step 3: No active game found. ALWAYS CREATE A NEW GAME SESSION.
        console.log(`No active game found for game ${gameId}. Creating a new session.`);

        const newGameStake = Number(gameId) > 0 ? Number(gameId) : FALLBACK_STAKE_AMOUNT;

        currentSessionId = uuidv4();
        game = await GameControl.create({
            GameSessionId: currentSessionId,
            gameId: gameId,
            isActive: DEFAULT_IS_ACTIVE,
            createdBy: DEFAULT_CREATED_BY,
            stakeAmount: newGameStake,
            totalCards: DEFAULT_GAME_TOTAL_CARDS,
            prizeAmount: 0,
            players: [],
            createdAt: new Date(),
            endedAt: null,
        });

        // --- Enrollment Logic (remains the same) ---
        // The rest of the enrollment logic, including card validation and balance check,
        // can proceed here, as we have a fresh 'game' document to work with.

        const isMemberDB = game.players.includes(telegramId);
        if (isMemberDB) {
            return res.status(200).json({
                success: true,
                gameId,
                telegramId,
                message: "You are already in the game.",
                GameSessionId: currentSessionId,
            });
        }
        
        const card = await GameCard.findOne({ gameId, cardId });
        if (!card || !card.isTaken || card.takenBy !== telegramId) {
            return res.status(400).json({ error: "Please try another card." });
        }

        const user = await User.findOneAndUpdate(
            { telegramId, balance: { $gte: game.stakeAmount }, $or: [{ reservedForGameId: { $exists: false } }, { reservedForGameId: null }, { reservedForGameId: "" }] },
            { $set: { reservedForGameId: gameId } },
            { new: true }
        );

        if (!user) {
            return res.status(400).json({ error: "Insufficient balance or you are already in another game." });
        }

        await GameControl.updateOne(
            { GameSessionId: currentSessionId },
            { $addToSet: { players: telegramId } }
        );

        await redis.sAdd(`gameRooms:${currentSessionId}`, telegramId);

        return res.status(200).json({
            success: true,
            gameId,
            telegramId,
            message: "Joined game successfully. Your stake has been reserved.",
            GameSessionId: currentSessionId,
        });

    } catch (error) {
        console.error("🔥 Game Start Error:", error);
        await User.updateOne(
            { telegramId },
            { $unset: { reservedForGameId: "" } }
        );
        return res.status(500).json({ error: "Internal server error." });
    } finally {
        // --- Step 4: RELEASE LOCK ---
        await redis.del(lockKey);
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
