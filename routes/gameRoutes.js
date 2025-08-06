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

    let game; 
    let currentSessionId; 

    try {
        // Step 1: Attempt to find an existing game session that is a lobby (not active, not ended).
        // 🟢 This query is more precise than just checking 'isActive: false'
        game = await GameControl.findOne({ gameId, isActive: false, endedAt: null });
        
        if (game) {
            // Case 1: An inactive game session (lobby) already exists.
            currentSessionId = game.GameSessionId;
            console.log(`✅ Found existing inactive game session ${currentSessionId} for game ${gameId}. Player joining this lobby.`);
        } else {
            // Case 2: No inactive lobby was found. Check if an active game is running.
            // 🟢 An active game is also one that has not yet ended.
            const activeGame = await GameControl.findOne({ gameId, isActive: true, endedAt: null });

            if (activeGame) {
                // Case 2a: A game is currently active. Block new players.
                return res.status(400).json({ error: "A game is currently in progress. Please wait for the next round." });
            } else {
                // Case 2b: No active lobby or active game was found.
                // This means all previous sessions for this gameId have ended.
                // Safely create a new session (the new lobby).
                console.log(`No active or inactive sessions found for game ${gameId}. Creating a new one.`);
                
                const parsedGameStake = Number(gameId);
                const newGameStake = (isNaN(parsedGameStake) || parsedGameStake <= 0)
                                        ? FALLBACK_STAKE_AMOUNT
                                        : parsedGameStake;
                
                const newGameTotalCards = DEFAULT_GAME_TOTAL_CARDS;
                const newGamePrizeAmount = 0; 
                
                // Generate a unique UUID for the new game session
                currentSessionId = uuidv4();
                game = await GameControl.create({
                    GameSessionId: currentSessionId,
                    gameId: gameId,
                    isActive: DEFAULT_IS_ACTIVE, // Set to false as it's a new lobby
                    createdBy: DEFAULT_CREATED_BY,
                    stakeAmount: newGameStake,
                    totalCards: newGameTotalCards,
                    prizeAmount: newGamePrizeAmount,
                    players: [],
                    createdAt: new Date(),
                    endedAt: null, // 🟢 Explicitly set to null for new sessions
                });
                console.log(`✅ New game session ${currentSessionId} created successfully for game ${gameId}.`);
            }
        }
        
        // --- All checks above ensure we have a valid 'game' document and 'currentSessionId' ---
        
        // Check Redis and MongoDB membership to prevent duplicate joins
        const isMemberRedis = await redis.sIsMember(`gameRooms:${gameId}`, telegramId);
        const isMemberDB = game.players.includes(telegramId);
        
        if (isMemberRedis && isMemberDB) {
            console.log(`User ${telegramId} already registered in session ${currentSessionId}. Proceeding with join.`);
        } else if (isMemberRedis && !isMemberDB) {
            await Promise.all([
                redis.sRem(`gameRooms:${gameId}`, telegramId),
                redis.sRem(`gameSessions:${gameId}`, telegramId),
            ]);
        }
        
        if (isMemberRedis && isMemberDB) {
            // No action needed, user is already a member
        } else {
            // Validate claimed card ownership
            const card = await GameCard.findOne({ gameId, cardId }); 
            if (!card || !card.isTaken || card.takenBy !== telegramId) {
                return res.status(400).json({ error: "Please try another card." });
            }

            // Check balance and set a reservation lock
            const user = await User.findOneAndUpdate(
                { telegramId, balance: { $gte: game.stakeAmount }, $or: [{ reservedForGameId: { $exists: false } }, { reservedForGameId: null }, { reservedForGameId: "" }] },
                { $set: { reservedForGameId: gameId } },
                { new: true }
            );

            if (!user) {
                return res.status(400).json({ error: "Insufficient balance or you are already in another game." });
            }

            // Add the player to the correct game session
            await GameControl.updateOne(
                { GameSessionId: currentSessionId },
                { $addToSet: { players: telegramId } }
            );

            // Add to Redis sets for real-time membership checks
            await redis.sAdd(`gameRooms:${gameId}`, telegramId);
        }

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
