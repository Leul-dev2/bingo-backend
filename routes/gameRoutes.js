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
    const lockAcquired = await redis.set(lockKey, 'locked', 'EX', 15, 'NX');

    if (!lockAcquired) {
        return res.status(429).json({ error: "A game start request is already being processed. Please wait a moment." });
    }

    // ⭐ Step 2: START A MONGOOSE SESSION AND TRANSACTION
    const session = await mongoose.startSession();
    let responseSent = false;
        try {
        await session.withTransaction(async () => {
            // 1️⃣ Check for ACTIVE game first
            const activeGame = await GameControl.findOne({
            gameId,
            isActive: true,
            endedAt: null
            }).session(session);

            if (activeGame) {
            responseSent = true;
            return res.status(400).json({
                success: false,
                message: "🚫 A game is already running. Please join it.",
                GameSessionId: activeGame.GameSessionId
            });
            }

            // 2️⃣ Check for INACTIVE lobby
            let lobbyDoc = await GameControl.findOne({
            gameId,
            isActive: false,
            endedAt: null
            }).session(session);

            // 3️⃣ Create lobby if it doesn't exist
            if (!lobbyDoc) {
            lobbyDoc = await GameControl.findOneAndUpdate(
                { gameId, isActive: false, endedAt: null },
                { $setOnInsert: {
                    GameSessionId: uuidv4(),
                    gameId,
                    isActive: false,
                    createdBy: DEFAULT_CREATED_BY,
                    stakeAmount: Number(gameId) > 0 ? Number(gameId) : FALLBACK_STAKE_AMOUNT,
                    totalCards: DEFAULT_GAME_TOTAL_CARDS,
                    prizeAmount: 0,
                    players: [],
                    houseProfit: 0,
                    createdAt: new Date(),
                    endedAt: null,
                }},
                { new: true, upsert: true, session, runValidators: true }
            );
            }

            const currentSessionId = lobbyDoc.GameSessionId;

            // --- Enrollment Logic: Auto-join lobby ---
            const isMemberDB = lobbyDoc.players.some(player => player.telegramId === telegramId);
            if (!isMemberDB) {
            // Step 6: Validate the card
            const card = await GameCard.findOne({ gameId, cardId }).session(session);
            if (!card || !card.isTaken || card.takenBy !== telegramId) {
                throw new Error("Invalid card. Please try another card.");
            }

            // Step 7: Reserve the user's stake
           const user = await User.findOneAndUpdate(
                {
                    telegramId,
                    $and: [
                        { // Condition 1: Check balance
                            $or: [
                                { bonus_balance: { $gte: lobbyDoc.stakeAmount } },
                                { balance: { $gte: lobbyDoc.stakeAmount } }
                            ]
                        },
                        { // Condition 2: Check reservation status (simplified)
                    $or: [
                            { reservedForGameId: { $exists: false } },
                            { reservedForGameId: null },
                            { reservedForGameId: "" }
                        ]
                        }
                    ]
                },
                { $set: { reservedForGameId: gameId } },
                { new: true, session }
            );

            if (!user) {
                throw new Error("Insufficient balance or already in another game.");
            }

            // Step 8: Add the user to the GameControl document
            await GameControl.updateOne(
                { GameSessionId: currentSessionId },
                { $addToSet: { players: { telegramId, status: 'connected' } } },
                { session }
            );

            // Step 9: Add user to Redis set
            await redis.sAdd(`gameRooms:${gameId}`, telegramId);
            }

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
            return res.status(400).json({ error: error.message || "Internal server error." });
        }
        } finally {
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