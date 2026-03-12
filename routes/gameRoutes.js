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

    const control = await SystemControl.getSingleton();

    if (!control.allowNewGames) {
        return res.status(403).json({
            success: false,
            message: "Currently disabled for maintenance."
        });
    }

    if (!cardIds || !Array.isArray(cardIds) || cardIds.length === 0 || cardIds.length > 2) {
        return res.status(400).json({ error: "You must select 1 or 2 cards." });
    }

    const gameStartingKey = `gameStarting:${strGameId}`;
    const session = await mongoose.startSession();

    try {
        // ── Your original check ONLY (no set/del — respects other pages) ──
        const isStarting = await redisClient.get(gameStartingKey);
        if (isStarting) {
            return res.status(400).json({ error: "🚫 Game is currently starting." });
        }

        // ── PERFORMANCE BOOST: Parallel reads + .lean() ──
        const [existingLobby, reservedCards, userDoc] = await Promise.all([
            GameControl.findOne({ gameId: strGameId, endedAt: null }).lean(),
            GameCard.find({
                gameId: strGameId,
                cardId: { $in: cardIds },
                isTaken: true,
                takenBy: Number(telegramId)
            }).lean(),
            User.findOne({ telegramId }).lean()
        ]);

        if (existingLobby?.status === "active") {
            return res.status(403).json({ 
                success: false,
                error: "Game is already in progress. You cannot join now." 
            });
        }

        // Optional: also block if already ended (good hygiene)
        if (existingLobby?.endedAt) {
            return res.status(410).json({ 
                success: false,
                error: "This game has already ended." 
            });
        }

        if (reservedCards.length !== cardIds.length) {
            return res.status(400).json({ error: "Invalid card or card not reserved by you." });
        }

        const stakeAmount = existingLobby?.stakeAmount 
            ?? (Number(strGameId) > 0 ? Number(strGameId) : FALLBACK_STAKE_AMOUNT);
        const totalStakeToReserve = stakeAmount * cardIds.length;

        // Fast user validation
        if (!userDoc || 
            (userDoc.reservedForGameId && userDoc.reservedForGameId !== strGameId)) {
            return res.status(400).json({ error: "You are already in another game." });
        }
        if ((userDoc.balance || 0) + (userDoc.bonus_balance || 0) < totalStakeToReserve) {
            return res.status(400).json({ error: "Insufficient balance." });
        }

        let lobbyDoc;

        // ── Tiny transaction (only 3 writes) ──
        await session.withTransaction(async () => {
            // Atomic lobby (no more try/catch 11000 race)
            lobbyDoc = await GameControl.findOneAndUpdate(
                { gameId: strGameId, endedAt: null },
                {
                    $setOnInsert: {
                        GameSessionId: uuidv4(),
                        isActive: false,
                        createdBy: DEFAULT_CREATED_BY,
                        stakeAmount,
                        totalCards: DEFAULT_GAME_TOTAL_CARDS,
                        prizeAmount: 0,
                        houseProfit: 0,
                        createdAt: new Date()
                    }
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
                        status: 'connected'
                    },
                    $setOnInsert: { joinedAt: new Date() }
                },
                { upsert: true, session }
            );
        });

        // Post-commit
        await redisClient.sAdd(`gameRooms:${strGameId}`, String(telegramId));

        return res.status(200).json({
            success: true,
            message: "Joined game successfully. Your stake has been reserved.",
            GameSessionId: lobbyDoc.GameSessionId
        });

    } catch (error) {
        if (session.inTransaction()) await session.abortTransaction();
        console.error("Start game error:", error);
        return res.status(400).json({ error: error.message || "An internal error occurred." });
    } finally {
        await session.endSession();
    }
    });

        return router;
    };
