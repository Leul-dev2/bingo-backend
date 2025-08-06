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

    let game; // Declare game variable outside try block for scope in catch
    let currentSessionId; // 🟢 Use a single variable for the session ID

    try {
        // 🟢 Find an existing game session that is not yet active (if you want to allow joining existing lobbies)
        // If you always want to create a new session, you can remove the findOne and just create.
        game = await GameControl.findOne({ gameId, isActive: false }); 
        
        if (!game) {
            // Create the game if it doesn't exist or no inactive game is found
            console.log(`No inactive game session found for ${gameId}. Creating a new one.`);
            
            const parsedGameStake = Number(gameId);
            const newGameStake = (isNaN(parsedGameStake) || parsedGameStake <= 0)
                                    ? FALLBACK_STAKE_AMOUNT
                                    : parsedGameStake;

            const newGameTotalCards = DEFAULT_GAME_TOTAL_CARDS;
            const newGamePrizeAmount = 0; 

            // 🟢 Generate a unique UUID for the new game session and assign to currentSessionId
            currentSessionId = uuidv4(); 
            console.log(`Generated new GameSessionId: ${currentSessionId}`);

            game = await GameControl.create({
                GameSessionId: currentSessionId, // 🟢 Use the assigned currentSessionId
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
        } else {
            // 🟢 If an existing inactive game is found, use its GameSessionId
            currentSessionId = game.GameSessionId;
            console.log(`✅ Found existing inactive game session ${currentSessionId} for game ${gameId}.`);
        }

        // Check Redis and MongoDB membership to prevent duplicate joins
        // Note: gameRooms and gameSessions are still keyed by gameId in your current Redis setup.
        // If you want these to be session-specific, you'd need to change their keys to use currentSessionId.
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
        // 🟢 If GameCard should also be session-specific, you'd add GameSessionId to its model and query here.
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
                $set: { reservedForGameId: gameId }, // Still using gameId for user reservation
            },
            { new: true }
        );

        if (!user) {
            return res.status(400).json({
                error: "Insufficient balance or you are already in another game.",
            });
        }

        // 🟢 Use the currentSessionId to find and update the specific game document
        await GameControl.updateOne(
            { GameSessionId: currentSessionId }, // 🟢 Use the assigned currentSessionId
            { $addToSet: { players: telegramId } }
        );

        // Add to Redis sets for real-time membership checks (still using gameId for the room name)
        await redis.sAdd(`gameRooms:${gameId}`, telegramId);

        return res.status(200).json({
            success: true,
            gameId,
            telegramId,
            message: "Joined game successfully. Your stake has been reserved.",
            GameSessionId: currentSessionId, // 🟢 Return the assigned currentSessionId
        });

    } catch (error) {
        console.error("🔥 Game Start Error:", error);

        // On any error after the user has been found, unset the reservation lock.
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
