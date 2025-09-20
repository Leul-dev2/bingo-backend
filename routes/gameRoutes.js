const express = require('express');
const router = express.Router();
const User = require("../models/user");
const GameControl = require('../models/GameControl');
const GameCard = require("../models/GameCard");
const redis = require("../utils/redisClient");
const { v4: uuidv4 } = require('uuid');
const mongoose = require('mongoose'); // ⭐ Import Mongoose for sessions

// --- IMPORTANT: Define these default values before your router.post block ---
const DEFAULT_GAME_TOTAL_CARDS = 1;
const FALLBACK_STAKE_AMOUNT = 10;
const DEFAULT_CREATED_BY = 'System';
const DEFAULT_IS_ACTIVE = false;

router.post("/start", async (req, res) => {
    const { gameId, telegramId, cardId } = req.body;

    // --- Step 1: ACQUIRE A DISTRIBUTED LOCK ---
    const lockKey = `startLock:${gameId}`;
    const lockAcquired = await redis.set(lockKey, 'locked', 'EX', 5, 'NX');

    if (!lockAcquired) {
        return res.status(429).json({ error: "A game start request is already being processed. Please wait a moment." });
    }

    // ⭐ Step 2: START A MONGOOSE SESSION AND TRANSACTION
    const session = await mongoose.startSession();
    let responseSent = false;
    try {
        await session.withTransaction(async () => {
            // ⭐ This is the atomic operation to find or create the lobby.
            const lobbyDoc = await GameControl.findOneAndUpdate(
                { gameId, isActive: false, endedAt: null },
                { $setOnInsert: {
                    GameSessionId: uuidv4(),
                    gameId,
                    isActive: false,
                    createdBy: 'System',
                    stakeAmount: Number(gameId) > 0 ? Number(gameId) : 10,
                    totalCards: 1,
                    prizeAmount: 0,
                    players: [],
                    houseProfit: 0,
                    createdAt: new Date(),
                    endedAt: null,
                }},
                { new: true, upsert: true, session, runValidators: true }
            );

            const currentSessionId = lobbyDoc.GameSessionId;
            
            // --- Enrollment Logic ---
            const isMemberDB = lobbyDoc.players.some(player => player.telegramId === telegramId);
            if (isMemberDB) {
                await session.abortTransaction();
                responseSent = true;
                return res.status(200).json({
                    success: true,
                    gameId,
                    telegramId,
                    message: "You are already in the game.",
                    GameSessionId: currentSessionId,
                });
            }

            // Step 6: Validate the card.
            const card = await GameCard.findOne({ gameId, cardId }).session(session);
            if (!card || !card.isTaken || card.takenBy !== telegramId) {
                await session.abortTransaction();
                responseSent = true;
                return res.status(400).json({ error: "Please try another card." });
            }

            // Step 7: Reserve the user's stake and prevent them from joining other games.
            const user = await User.findOneAndUpdate(
                {
                    telegramId,
                    $or: [
                        { bonus_balance: { $gte: lobbyDoc.stakeAmount } },
                        { balance: { $gte: lobbyDoc.stakeAmount } }
                    ],
                    $or: [{ reservedForGameId: { $exists: false } }, { reservedForGameId: null }, { reservedForGameId: "" }]
                },
                { $set: { reservedForGameId: gameId } },
                { new: true, session }
            );

            if (!user) {
                await session.abortTransaction();
                responseSent = true;
                return res.status(400).json({ error: "Insufficient balance or you are already in another game." });
            }

            // Step 8: Add the user to the GameControl document.
            await GameControl.updateOne(
                { GameSessionId: currentSessionId },
                { $addToSet: { players: { telegramId, status: 'connected' } } },
                { session }
            );

            // Step 9: Add the user to the Redis set for real-time tracking.
            await redis.sAdd(`gameRooms:${gameId}`, telegramId);
            
            responseSent = true;
            return res.status(200).json({
                success: true,
                gameId,
                telegramId,
                message: "Joined game successfully. Your stake has been reserved.",
                GameSessionId: currentSessionId,
            });
        });
    } catch (error) {
        console.error("🔥 Game Start Error:", error);
        if (!responseSent) {
            // Check if it's a duplicate key error from the unique index
            if (error.name === 'MongoError' && error.code === 11000) {
                 return res.status(409).json({ error: "A game lobby is being created. Please try again in a moment." });
            }
            return res.status(500).json({ error: "Internal server error." });
        }
    } finally {
        // --- Step 10: RELEASE THE LOCK AND END THE SESSION ---
        await redis.del(lockKey);
        await session.endSession();
    }
});

// ... (your existing /status route below)
router.get('/:gameId/status', async (req, res) => {
    const { gameId } = req.params;

    try {
        const isActiveStr = await redis.get(`gameIsActive:${gameId}`);

        if (isActiveStr !== null) {
            return res.json({
                isActive: isActiveStr === 'true',
                exists: true
            });
        }

        const game = await GameControl.findOne({ gameId });
        if (!game) {
            return res.status(404).json({
                isActive: false,
                message: 'Game not found',
                exists: false
            });
        }

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