const express = require('express');
const router = express.Router();
const User = require("../models/user");
const GameControl = require('../models/GameControl');
const GameCard = require("../models/GameCard");
const redis = require("../utils/redisClient"); // Your Redis client import
const { v4: uuidv4 } = require('uuid'); // 🟢 Import UUID library

// --- IMPORTANT: Define these default values before your router.post block ---
// DEFAULT_GAME_STAKE_AMOUNT is removed as gameId will now provide the stake.
const DEFAULT_GAME_TOTAL_CARDS = 1;   // A numeric default for cards (e.g., 75 cards)
const FALLBACK_STAKE_AMOUNT = 10;      // A fallback stake if gameId is not a valid number, or <= 0
const DEFAULT_CREATED_BY = 'System'; // Default creator if not specified
const DEFAULT_IS_ACTIVE = false;  // Default status for a newly created game

router.post("/start", async (req, res) => {
    // Frontend only sends gameId and telegramId, so destructure only those.
    const { gameId, telegramId, cardId } = req.body;

    let game; // Declare game variable outside try block for scope in catch
    let newGameSessionId;

    try {
        game = await GameControl.findOne({ gameId });
        if (!game) {
            // Create the game if it doesn't exist
            console.log(`Game ${gameId} not found. Creating new game with default parameters.`);
            
            const parsedGameStake = Number(gameId);
            const newGameStake = (isNaN(parsedGameStake) || parsedGameStake <= 0)
                                 ? FALLBACK_STAKE_AMOUNT
                                 : parsedGameStake;

            const newGameTotalCards = DEFAULT_GAME_TOTAL_CARDS;
            // Prize is still initialized to 0, as it will be calculated later
            const newGamePrizeAmount = 0; 

            // 🟢 Generate a unique UUID for the new game session
            const newGameSessionId = uuidv4();
            console.log(`Generated new GameSessionId: ${newGameSessionId}`);


            game = await GameControl.create({
                GameSessionId: newGameSessionId, // 🟢 Include the UUID here
                gameId: gameId,
                isActive: DEFAULT_IS_ACTIVE,
                createdBy: DEFAULT_CREATED_BY,
                stakeAmount: newGameStake, 
                totalCards: newGameTotalCards,
                prizeAmount: newGamePrizeAmount,
                players: [],
                createdAt: new Date(),
            });
            console.log(`✅ Game ${gameId} created successfully with stake ${newGameStake} and ${newGameTotalCards} cards.`);
        }

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
                // Check for sufficient balance and that user is not reserved for another game
                balance: { $gte: game.stakeAmount },
                $or: [
                  { reservedForGameId: { $exists: false } }, // Field does not exist
                  { reservedForGameId: null },                // Field exists and is null
                  { reservedForGameId: "" }                   // Field exists and is an empty string
              ]
            },
            {
                // Lock the user's funds by setting a reservation flag with the current gameId
                $set: { reservedForGameId: gameId },
                // NO $inc: { balance: -game.stakeAmount } here! The deduction happens later.
            },
            { new: true }
        );

        if (!user) {
            // This error now covers insufficient balance OR the user is already in another game
            return res.status(400).json({
                error: "Insufficient balance or you are already in another game.",
            });
        }

 // 🟢 Use the newGameSessionId to find and update the specific game document
        await GameControl.updateOne(
            { GameSessionId: newGameSessionId }, // 🟢 Changed from { gameId }
            { $addToSet: { players: telegramId } }
        );

        // Add to Redis sets for real-time membership checks (still using gameId for the room name)
        await redis.sAdd(`gameRooms:${gameId}`, telegramId);

        return res.status(200).json({
            success: true,
            gameId,
            telegramId,
            message: "Joined game successfully. Your stake has been reserved.",
            GameSessionId: newGameSessionId, // 🟢 You can also return this to the client
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
