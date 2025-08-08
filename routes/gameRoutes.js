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
    
    // --- Step 1: ACQUIRE A DISTRIBUTED LOCK ---
    const lockKey = `startLock:${gameId}`; 
    const lockAcquired = await redis.set(lockKey, 'locked', 'EX', 5, 'NX');

    if (!lockAcquired) {
        return res.status(429).json({ error: "A game start request is already being processed. Please wait a moment." });
    }

    try {
        // --- Game Logic starts here, protected by the lock ---
        // Step 2: Check for an ACTIVE game session.
        const activeGame = await GameControl.findOne({ gameId, isActive: true, endedAt: null });
        if (activeGame) {
            return res.status(400).json({ error: "A game is currently in progress. Please wait for the next round." });
        }

        // Step 3: Check for an INACTIVE game session (a lobby) that is still open.
        const existingLobby = await GameControl.findOne({ gameId, isActive: false, endedAt: null });
        if (existingLobby) {
            currentSessionId = existingLobby.GameSessionId;
            game = existingLobby;
        } else {
            // Step 4: No active game or existing lobby. CREATE a new one.
            try {
                currentSessionId = uuidv4();
                const newGameStake = Number(gameId) > 0 ? Number(gameId) : 10;

                game = await GameControl.create({
                    GameSessionId: currentSessionId,
                    gameId,
                    isActive: false,
                    createdBy: 'System',
                    stakeAmount: newGameStake,
                    totalCards: 1,
                    prizeAmount: 0,
                    players: [],
                    createdAt: new Date(),
                    endedAt: null,
                });
            } catch (err) {
                console.error("⚠️ Error creating new game session:", err);
                return res.status(500).json({ error: "Failed to create game session. Please try again." });
            }
        }

        // --- Enrollment Logic ---
        // 🟢 CORRECTED: Use .some() to check for an object with a matching telegramId
        const isMemberDB = game.players.some(player => player.telegramId === telegramId);
        if (isMemberDB) {
            return res.status(200).json({
                success: true,
                gameId,
                telegramId,
                message: "You are already in the game.",
                GameSessionId: currentSessionId,
            });
        }
        
        // Step 6: Validate the card.
        const card = await GameCard.findOne({ gameId, cardId });
        if (!card || !card.isTaken || card.takenBy !== telegramId) {
            return res.status(400).json({ error: "Please try another card." });
        }

        // Step 7: Reserve the user's stake and prevent them from joining other games.
        const user = await User.findOneAndUpdate(
            { telegramId, balance: { $gte: game.stakeAmount }, $or: [{ reservedForGameId: { $exists: false } }, { reservedForGameId: null }, { reservedForGameId: "" }] },
            { $set: { reservedForGameId: gameId } },
            { new: true }
        );

        if (!user) {
            return res.status(400).json({ error: "Insufficient balance or you are already in another game." });
        }

        // 🟢 CORRECTED: Provide a full player object, not just the telegramId
        await GameControl.updateOne(
            { GameSessionId: currentSessionId },
            { $addToSet: { players: { telegramId, status: 'connected' } } }
        );

        // Step 9: Add the user to the Redis set for real-time tracking.
        await redis.sAdd(`gameRooms:${gameId}`, telegramId);

        return res.status(200).json({
            success: true,
            gameId,
            telegramId,
            message: "Joined game successfully. Your stake has been reserved.",
            GameSessionId: currentSessionId,
        });

    } catch (error) {
        // --- Error Handling and Cleanup ---
        console.error("🔥 Game Start Error:", error);
        await User.updateOne(
            { telegramId },
            { $unset: { reservedForGameId: "" } }
        );
        return res.status(500).json({ error: "Internal server error." });
    } finally {
        // --- Step 10: RELEASE THE LOCK ---
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
