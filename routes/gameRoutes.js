const express = require('express');
const User = require("../models/user");
const GameControl = require('../models/GameControl');
const GameCard = require("../models/GameCard");
const PlayerSession = require("../models/PlayerSession");
const SystemControl = require("../models/SystemControl")
const { v4: uuidv4 } = require('uuid');
const mongoose = require('mongoose');

// --- Default Game Values ---
const DEFAULT_GAME_TOTAL_CARDS = 1;
const FALLBACK_STAKE_AMOUNT = 10;
const DEFAULT_CREATED_BY = 'System';

/**
 * Game Routes Router Factory.
 * Accepts the pre-initialized Redis client for dependency injection.
 * @param {import('redis').RedisClientType} redisClient - The shared Redis client instance.
 * @returns {express.Router} The configured Express router.
 */
// ... all the 'require' statements are the same ...

    module.exports = (redisClient) => { 
        const router = express.Router();

    router.post("/start", async (req, res) => {
        const { gameId, telegramId, cardIds, username } = req.body;
        const strGameId = String(gameId);

        // ── System-level kill switch ──────────────────────────────────────────
        const control = await SystemControl.getSingleton();
        if (!control.allowNewGames) {
            return res.status(403).json({
                success: false,
                message: "Currently disabled for maintenance.",
            });
        }

        // ── Basic input validation ────────────────────────────────────────────
        if (!cardIds || !Array.isArray(cardIds) || cardIds.length === 0 || cardIds.length > 2) {
            return res.status(400).json({ error: "You must select 1 or 2 cards." });
        }

        const session = await mongoose.startSession();

        
        const startLockKey = `lock:start:${strGameId}:${telegramId}`;
        const gotLock = await redisClient.set(startLockKey, "1", { NX: true, EX: 10 });
        if (!gotLock) {
            return res.status(429).json({ error: "Request already in progress." });
        }

        try {
            // ── FIX 6A: Three-layer active-game guard ─────────────────────────
            //
            // Layer 1: gameIsActive Redis key (fastest — set by syncGameIsActive)
            const [gameIsActiveRaw, gameStartingRaw] = await Promise.all([
                redisClient.get(`gameIsActive:${strGameId}`),
                redisClient.get(`gameStarting:${strGameId}`),
            ]);

            if (gameIsActiveRaw === "true") {
                return res.status(403).json({
                    success: false,
                    error:   "Game is already in progress. You cannot join now.",
                });
            }

            // Layer 2: gameStarting key (set when countdown hits 0, before isActive is true)
            if (gameStartingRaw) {
                return res.status(403).json({
                    success: false,
                    error:   "Game is about to start. You cannot join now.",
                });
            }

            // ── Parallel DB reads ─────────────────────────────────────────────
            const [existingLobby, reservedCards, userDoc] = await Promise.all([
                GameControl.findOne({ gameId: strGameId, endedAt: null }).lean(),
                GameCard.find({
                    gameId:  strGameId,
                    cardId:  { $in: cardIds },
                    isTaken: true,
                    takenBy: Number(telegramId),
                }).lean(),
                User.findOne({ telegramId }).lean(),
            ]);

            console.log(
                `[START ROUTE] existingLobby: ${existingLobby ? "found" : "not found"}` +
                ` | isActive=${existingLobby?.isActive} | endedAt=${existingLobby?.endedAt || "(none)"}`
            );
            console.log(`[START ROUTE] reservedCards: ${reservedCards.length} (expected ${cardIds.length})`);

            // Layer 3: DB isActive check (source of truth, catches Redis-miss edge case)
            if (existingLobby?.isActive === true) {
                console.log(`[START ROUTE] Blocked: game is active | game ${strGameId} | user ${telegramId}`);
                return res.status(403).json({
                    success: false,
                    error:   "Game is already in progress. You cannot join now.",
                });
            }

            if (existingLobby?.endedAt) {
                return res.status(410).json({
                    success: false,
                    error:   "This game has already ended.",
                });
            }
            // ── End FIX 6A ───────────────────────────────────────────────────

            if (reservedCards.length !== cardIds.length) {
                return res.status(400).json({ error: "Invalid card or card not reserved by you." });
            }

            const stakeAmount = existingLobby?.stakeAmount
                ?? (Number(strGameId) > 0 ? Number(strGameId) : FALLBACK_STAKE_AMOUNT);
            const totalStakeToReserve = stakeAmount * cardIds.length;

            if (!userDoc ||
                (userDoc.reservedForGameId && userDoc.reservedForGameId !== strGameId)) {
                return res.status(400).json({ error: "You are already in another game." });
            }
            if ((userDoc.balance || 0) + (userDoc.bonus_balance || 0) < totalStakeToReserve) {
                return res.status(400).json({ error: "Insufficient balance." });
            }

            let lobbyDoc;

            await session.withTransaction(async () => {
                lobbyDoc = await GameControl.findOneAndUpdate(
                    { gameId: strGameId, endedAt: null },
                    {
                        $setOnInsert: {
                            GameSessionId: uuidv4(),
                            isActive:      false,
                            createdBy:     DEFAULT_CREATED_BY,
                            stakeAmount,
                            totalCards:    DEFAULT_GAME_TOTAL_CARDS,
                            prizeAmount:   0,
                            houseProfit:   0,
                            createdAt:     new Date(),
                        },
                    },
                    { upsert: true, new: true, session }
                );

                await User.updateOne(
                    { telegramId },
                    { $set: { reservedForGameId: strGameId } },
                    { session }
                );

                await PlayerSession.findOneAndUpdate(
                    { GameSessionId: lobbyDoc.GameSessionId, telegramId: Number(telegramId) },
                    {
                        $set: {
                            username: username || `User ${telegramId}`,
                            cardIds,
                            status:   "connected",
                        },
                        $setOnInsert: { joinedAt: new Date() },
                    },
                    { upsert: true, session }
                );
            });

            // Post-commit Redis updates
            await Promise.all([
                redisClient.sAdd(`gameRooms:${strGameId}`, String(telegramId)),
                // In gameRoutes.js post-commit Promise.all, ADD:
                redisClient.set(`gameSessionId:${strGameId}`, lobbyDoc.GameSessionId, { EX: 7200 }),
                // FIX: Increment connectedCount so gameCount.js sees the right number
                //redisClient.incr(`connectedCount:${lobbyDoc.GameSessionId}`),
            ]);

            return res.status(200).json({
                success:       true,
                message:       "Joined game successfully. Your stake has been reserved.",
                GameSessionId: lobbyDoc.GameSessionId,
            });

        } catch (error) {
            if (session.inTransaction()) await session.abortTransaction();
            console.error("Start game error:", error);
            return res.status(400).json({ error: error.message || "An internal error occurred." });
        } finally {
            await redisClient.del(startLockKey);
            await session.endSession();
        }
    });

        return router;
    };
