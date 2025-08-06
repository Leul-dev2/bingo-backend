const express = require('express');
const router = express.Router();
const User = require("../models/user");
const GameControl = require('../models/GameControl');
const GameCard = require("../models/GameCard");
const redis = require("../utils/redisClient"); // Your Redis client import
const { v4: uuidv4 } = require('uuid'); // 🟢 Import UUID library

// --- IMPORTANT: Define these default values before your router.post block ---
const DEFAULT_GAME_TOTAL_CARDS = 1;
const FALLBACK_STAKE_AMOUNT = 10;
const DEFAULT_CREATED_BY = 'System';
const DEFAULT_IS_ACTIVE = false;

router.post("/start", async (req, res) => {
    const { gameId, telegramId, cardId } = req.body;

    let game;
    let currentSessionId;

    try {
        // 🟢 ALWAYS create a new game session with a unique ID
        console.log(`Creating a new game session for game ${gameId}.`);
        
        const parsedGameStake = Number(gameId);
        const newGameStake = (isNaN(parsedGameStake) || parsedGameStake <= 0)
                                ? FALLBACK_STAKE_AMOUNT
                                : parsedGameStake;

        const newGameTotalCards = DEFAULT_GAME_TOTAL_CARDS;
        const newGamePrizeAmount = 0; 

        // 🟢 Generate a unique UUID for the new game session
        currentSessionId = uuidv4(); 
        console.log(`Generated new GameSessionId: ${currentSessionId}`);

        game = await GameControl.create({
            GameSessionId: currentSessionId, // Use the assigned currentSessionId
            gameId: gameId,
            isActive: DEFAULT_IS_ACTIVE,
            createdBy: DEFAULT_CREATED_BY,
            stakeAmount: newGameStake, 
            totalCards: newGameTotalCards,
            prizeAmount: newGamePrizeAmount,
            players: [],
            createdAt: new Date(),
        });
        console.log(`✅ Game session ${currentSessionId} created successfully for game ${gameId}.`);
        
        // --- The rest of the logic remains the same as it now has the 'game' object and 'currentSessionId' ---

        // Check Redis and MongoDB membership to prevent duplicate joins
        const isMemberRedis = await redis.sIsMember(`gameRooms:${gameId}`, telegramId);
        const isMemberDB = game.players.includes(telegramId);

        if (isMemberRedis && !isMemberDB) {
            await Promise.all([
                redis.sRem(`gameRooms:${gameId}`, telegramId),
                redis.sRem(`gameSessions:${gameId}`, telegramId),
            ]);
        } else if (isMemberRedis && isMemberDB) {
            return res.status(400).json({ error: "You already joined this game." });
        }

        // Validate claimed card ownership
        const card = await GameCard.findOne({ gameId, cardId }); 

        if (!card || !card.isTaken || card.takenBy !== telegramId) {
            return res.status(400).json({
                error: "Please try another card.",
            });
        }

        // --- KEY CHANGE: CHECK BALANCE and SET A LOCK, BUT DO NOT DEDUCT ---
        const user = await User.findOneAndUpdate(
            {
                telegramId,
                balance: { $gte: game.stakeAmount },
                $or: [
                    { reservedForGameId: { $exists: false } },
                    { reservedForGameId: null },
                    { reservedForGameId: "" }
                ]
            },
            {
                $set: { reservedForGameId: gameId },
            },
            { new: true }
        );

        if (!user) {
            return res.status(400).json({
                error: "Insufficient balance or you are already in another game.",
            });
        }

        // Use the currentSessionId to find and update the specific game document
        await GameControl.updateOne(
            { GameSessionId: currentSessionId },
            { $addToSet: { players: telegramId } }
        );

        // Add to Redis sets for real-time membership checks
        await redis.sAdd(`gameRooms:${gameId}`, telegramId);

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
