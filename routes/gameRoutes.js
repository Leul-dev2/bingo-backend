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

const LOCK_TTL = 30000; // 30 seconds
const LOCK_RENEW_INTERVAL = 10000; // 10 seconds

router.post("/start", async (req, res) => {
    const { gameId, telegramId, cardId } = req.body;
    const lockKey = `startLock:${gameId}`;
    let lockRenewalInterval;

    // --- Step 1: Acquire lock ---
    const lockAcquired = await redis.set(lockKey, 'locked', 'NX', 'PX', LOCK_TTL);
    if (!lockAcquired) {
        return res.status(429).json({ error: "A game start request is already being processed. Please wait a moment." });
    }

    try {
        // --- Step 1a: Start lock renewal ---
        lockRenewalInterval = setInterval(async () => {
            await redis.pexpire(lockKey, LOCK_TTL); // extend TTL
        }, LOCK_RENEW_INTERVAL);

        // --- Step 2: Start MongoDB transaction ---
        const session = await mongoose.startSession();
        let responseSent = false;

        try {
            await session.withTransaction(async () => {
                const lobbyDoc = await GameControl.findOneAndUpdate(
                    { gameId, isActive: false, endedAt: null },
                    {
                        $setOnInsert: {
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
                        }
                    },
                    { new: true, upsert: true, session, runValidators: true }
                );

                const currentSessionId = lobbyDoc.GameSessionId;

                // Validate card
                const card = await GameCard.findOne({ gameId, cardId }).session(session);
                if (!card || !card.isTaken || card.takenBy !== telegramId) {
                    await session.abortTransaction();
                    responseSent = true;
                    return res.status(400).json({ error: "Please try another card." });
                }

                // Reserve user's stake
                const user = await User.findOneAndUpdate(
                    { telegramId, balance: { $gte: lobbyDoc.stakeAmount }, $or: [{ reservedForGameId: { $exists: false } }, { reservedForGameId: null }, { reservedForGameId: "" }] },
                    { $set: { reservedForGameId: gameId } },
                    { new: true, session }
                );

                if (!user) {
                    await session.abortTransaction();
                    responseSent = true;
                    return res.status(400).json({ error: "Insufficient balance or you are already in another game." });
                }

                // Add player atomically
                await GameControl.updateOne(
                    { GameSessionId: currentSessionId },
                    { $addToSet: { players: { telegramId, status: 'connected' } } },
                    { session }
                );

                // Redis real-time tracking
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
        } catch (err) {
            console.error("🔥 Game Start Error:", err);
            if (!responseSent) {
                return res.status(500).json({ error: "Internal server error." });
            }
        } finally {
            await session.endSession();
        }
    } finally {
        // --- Step 3: Clear lock renewal and release lock ---
        clearInterval(lockRenewalInterval);
        await redis.del(lockKey);
    }
});


// ... (your existing /status route below)
router.get('/:gameId/status', async (req, res) => {
     const { gameId } = req.params;
     const gameIdStr = String(gameId);
     console.log("🚀 /status route hit with gameId:", gameIdStr);

    try {
        const isActiveStr = await redis.get(`gameIsActive:${gameId}`);

        if (isActiveStr !== null) {
            return res.json({
                isActive: isActiveStr === 'true',
                exists: true
            });
        }


        console.log("gameIdStr:", gameIdStr);
        const game = await GameControl.findOne({ gameId: gameIdStr });
        console.log("gameid to find ", game);
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