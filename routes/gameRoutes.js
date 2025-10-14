const express = require('express');
const router = express.Router();
const User = require("../models/user");
const GameControl = require('../models/GameControl');
const GameCard = require("../models/GameCard");
const redis = require("../utils/redisClient");
const { v4: uuidv4 } = require('uuid');
const mongoose = require('mongoose');

// Constants
const DEFAULT_GAME_TOTAL_CARDS = 1;
const FALLBACK_STAKE_AMOUNT = 10;
const DEFAULT_CREATED_BY = 'System';
const DEFAULT_IS_ACTIVE = false;

router.post("/start", async (req, res) => {
    const { gameId, telegramId, cardId } = req.body;

    // Validation
    if (!gameId || !telegramId || !cardId) {
        return res.status(400).json({ 
            success: false, 
            error: "Missing required fields: gameId, telegramId, cardId" 
        });
    }

    const lockKey = `startLock:${gameId}`;
    const session = await mongoose.startSession();
    let lockAcquired = false;

    try {
        // Acquire distributed lock
        lockAcquired = await redis.set(lockKey, 'locked', 'EX', 15, 'NX');
        if (!lockAcquired) {
            return res.status(429).json({ 
                success: false,
                error: "A game start request is already being processed. Please wait a moment." 
            });
        }

        let result;
        await session.withTransaction(async () => {
            // 1. Check for ACTIVE game
            const activeGame = await GameControl.findOne({
                gameId,
                isActive: true,
                endedAt: null
            }).session(session);

            if (activeGame) {
                throw new Error(`ACTIVE_GAME_EXISTS:${activeGame.GameSessionId}`);
            }

            // 2. Check for INACTIVE lobby or create one
            let lobbyDoc = await GameControl.findOne({
                gameId,
                isActive: false,
                endedAt: null
            }).session(session);

            if (!lobbyDoc) {
                lobbyDoc = new GameControl({
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
                });
                await lobbyDoc.save({ session });
            }

            const currentSessionId = lobbyDoc.GameSessionId;

            // 3. Check if user is already in the lobby
            const isMemberDB = lobbyDoc.players.some(player => 
                player.telegramId === telegramId
            );

            if (isMemberDB) {
                result = {
                    success: true,
                    gameId,
                    telegramId,
                    message: "Already in lobby",
                    GameSessionId: currentSessionId,
                };
                return;
            }

            // 4. Validate the card
            const card = await GameCard.findOne({ 
                gameId, 
                cardId 
            }).session(session);
            
            if (!card || !card.isTaken || card.takenBy !== telegramId) {
                throw new Error("INVALID_CARD:Please try another card.");
            }

            // 5. Reserve user's stake with proper atomic check
            const user = await User.findOneAndUpdate(
                {
                    telegramId,
                    $or: [
                        { reservedForGameId: { $exists: false } },
                        { reservedForGameId: null },
                        { reservedForGameId: "" }
                    ],
                    $or: [
                        { bonus_balance: { $gte: lobbyDoc.stakeAmount } },
                        { balance: { $gte: lobbyDoc.stakeAmount } }
                    ]
                },
                { 
                    $set: { 
                        reservedForGameId: currentSessionId, // ✅ FIXED: Use GameSessionId, not gameId
                        lastGameJoinAttempt: new Date()
                    } 
                },
                { 
                    new: true, 
                    session,
                    runValidators: true 
                }
            );

            if (!user) {
                throw new Error("RESERVATION_FAILED:Insufficient balance or already in another game.");
            }

            // 6. Add user to GameControl
            await GameControl.updateOne(
                { GameSessionId: currentSessionId },
                { 
                    $addToSet: { 
                        players: { 
                            telegramId, 
                            status: 'connected',
                            joinedAt: new Date()
                        } 
                    } 
                },
                { session }
            );

            // 7. Update Redis cache
            await redis.sAdd(`gameRooms:${gameId}`, telegramId);
            await redis.del(`gameIsActive:${gameId}`); // Invalidate cache

            result = {
                success: true,
                gameId,
                telegramId,
                message: "Joined game successfully. Your stake has been reserved.",
                GameSessionId: currentSessionId,
                stakeAmount: lobbyDoc.stakeAmount
            };
        });

        // Send response AFTER transaction commits
        return res.status(200).json(result);

    } catch (error) {
        console.error("🔥 Game Start Error:", error);

        // Handle specific error types
        if (error.message.startsWith('ACTIVE_GAME_EXISTS:')) {
            const sessionId = error.message.split(':')[1];
            return res.status(400).json({
                success: false,
                message: "🚫 A game is already running. Please join it.",
                GameSessionId: sessionId
            });
        }

        if (error.message.startsWith('INVALID_CARD:')) {
            return res.status(400).json({
                success: false,
                error: error.message.split(':')[1]
            });
        }

        if (error.message.startsWith('RESERVATION_FAILED:')) {
            return res.status(400).json({
                success: false,
                error: error.message.split(':')[1]
            });
        }

        return res.status(500).json({ 
            success: false,
            error: "Internal server error. Please try again." 
        });

    } finally {
        // Cleanup
        if (lockAcquired) {
            await redis.del(lockKey).catch(console.error);
        }
        await session.endSession().catch(console.error);
    }
});

// Enhanced status endpoint
router.get('/:gameId/status', async (req, res) => {
    const { gameId } = req.params;

    try {
        // Try Redis cache first
        const cachedStatus = await redis.get(`gameIsActive:${gameId}`);
        if (cachedStatus !== null) {
            return res.json({
                success: true,
                isActive: cachedStatus === 'true',
                exists: true,
                source: 'cache'
            });
        }

        // Database lookup
        const game = await GameControl.findOne({ gameId })
            .sort({ createdAt: -1 }) // Get most recent game
            .select('isActive players stakeAmount createdAt endedAt')
            .lean();

        if (!game) {
            // Cache negative result to prevent DB queries
            await redis.set(`gameIsActive:${gameId}`, 'false', 'EX', 30);
            return res.status(404).json({
                success: false,
                isActive: false,
                message: 'Game not found',
                exists: false
            });
        }

        // Cache the result
        await redis.set(`gameIsActive:${gameId}`, game.isActive ? 'true' : 'false', 'EX', 60);

        return res.json({
            success: true,
            isActive: game.isActive,
            exists: true,
            playersCount: game.players?.length || 0,
            stakeAmount: game.stakeAmount,
            createdAt: game.createdAt,
            source: 'database'
        });

    } catch (error) {
        console.error("Status check error:", error);
        return res.status(500).json({
            success: false,
            isActive: false,
            message: 'Server error during status check',
            exists: false
        });
    }
});

// New endpoint: Get user's current game status
router.get('/user/:telegramId/status', async (req, res) => {
    const { telegramId } = req.params;

    try {
        const user = await User.findOne({ telegramId })
            .select('reservedForGameId balance bonus_balance')
            .lean();

        if (!user) {
            return res.status(404).json({
                success: false,
                message: 'User not found'
            });
        }

        let currentGame = null;
        if (user.reservedForGameId) {
            currentGame = await GameControl.findOne({
                GameSessionId: user.reservedForGameId
            }).select('gameId isActive stakeAmount players').lean();
        }

        res.json({
            success: true,
            user: {
                telegramId,
                balance: user.balance,
                bonus_balance: user.bonus_balance,
                reservedForGameId: user.reservedForGameId
            },
            currentGame: currentGame ? {
                gameId: currentGame.gameId,
                isActive: currentGame.isActive,
                stakeAmount: currentGame.stakeAmount,
                playerCount: currentGame.players?.length || 0
            } : null
        });

    } catch (error) {
        console.error("User status check error:", error);
        res.status(500).json({
            success: false,
            error: "Internal server error"
        });
    }
});

module.exports = router;