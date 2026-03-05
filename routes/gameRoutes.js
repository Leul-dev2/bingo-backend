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

    // ── Keep your existing safety checks ──
    const control = await SystemControl.getSingleton();
    if (!control.allowNewGames) {
        return res.status(403).json({ success: false, message: "Currently disabled for maintenance." });
    }

    const gameStartingKey = `gameStarting:${strGameId}`;
    if (await redisClient.get(gameStartingKey)) {
        return res.status(400).json({ error: "🚫 Game is currently starting." });
    }

    // ── NEW: Redis atomic creator election ──
    const creationLockKey = `lobby:creating:${strGameId}`;
    const sessionKey     = `lobby:session:${strGameId}`;

    let GameSessionId = null;
    const IAmCreator = await redisClient.set(creationLockKey, "1", { NX: true, EX: 10 });

    const mongoSession = await mongoose.startSession();

    try {
        // 1. Only ONE player creates the lobby
        if (IAmCreator === 'OK') {
            console.log(`🏆 Player ${telegramId} won lobby creation for game ${strGameId}`);

            GameSessionId = uuidv4();

            await GameControl.create([{
                GameSessionId,
                gameId: strGameId,
                isActive: false,
                createdBy: DEFAULT_CREATED_BY,
                stakeAmount: Number(strGameId) > 0 ? Number(strGameId) : FALLBACK_STAKE_AMOUNT,
                totalCards: DEFAULT_GAME_TOTAL_CARDS,
                prizeAmount: 0,
                houseProfit: 0,
                createdAt: new Date(),
                endedAt: null,
            }]);

            // Publish to Redis so others see it instantly
            await redisClient.set(sessionKey, GameSessionId, { EX: 300 });
        } 
        else {
            // 199 players wait max ~300ms for the creator
            for (let attempt = 0; attempt < 5; attempt++) {
                GameSessionId = await redisClient.get(sessionKey);
                if (GameSessionId) break;
                await new Promise(r => setTimeout(r, 60)); // 60ms backoff
            }

            if (!GameSessionId) {
                return res.status(503).json({ error: "Game is being created. Please click again in 1 second." });
            }
        }

        // ── 2. EVERYONE joins the SAME game (same code as before) ──
        await mongoSession.withTransaction(async () => {
            // Card validation
            const cards = await GameCard.find({
                gameId: strGameId,
                cardId: { $in: cardIds },
                isTaken: true,
                takenBy: Number(telegramId)
            }).session(mongoSession);

            if (cards.length !== cardIds.length) {
                throw new Error("Invalid card or card not reserved by you.");
            }

            const totalStakeToReserve = (Number(strGameId) > 0 ? Number(strGameId) : FALLBACK_STAKE_AMOUNT) * cardIds.length;

            // Balance reservation
            const user = await User.findOneAndUpdate(
                {
                    telegramId,
                    $or: [
                        { reservedForGameId: { $exists: false } },
                        { reservedForGameId: null },
                        { reservedForGameId: "" },
                        { reservedForGameId: strGameId }
                    ],
                    $or: [
                        { bonus_balance: { $gte: totalStakeToReserve } },
                        { balance: { $gte: totalStakeToReserve } }
                    ]
                },
                { $set: { reservedForGameId: strGameId } },
                { new: true, session: mongoSession }
            );

            if (!user) throw new Error("Insufficient balance or you are already in another game.");

            // PlayerSession
            await PlayerSession.findOneAndUpdate(
                { GameSessionId, telegramId: Number(telegramId) },
                {
                    $set: { username: username || `User ${telegramId}`, cardIds, status: 'connected' },
                    $setOnInsert: { joinedAt: new Date() }
                },
                { upsert: true, session: mongoSession }
            );
        });

        // ── 3. Final Redis join ──
        await redisClient.sAdd(`gameRooms:${strGameId}`, telegramId);

        return res.json({
            success: true,
            message: "Joined game successfully. Your stake has been reserved.",
            GameSessionId
        });

    } catch (error) {
        if (IAmCreator === 'OK') await redisClient.del(creationLockKey); // cleanup on error
        if (mongoSession.inTransaction()) await mongoSession.abortTransaction();

        const code = error.statusCode || 400;
        return res.status(code).json({ error: error.message || "An internal error occurred." });

    } finally {
        await mongoSession.endSession();
        if (IAmCreator === 'OK') {
            // Clean up Redis keys after a few seconds
            setTimeout(() => redisClient.del(creationLockKey, sessionKey), 15000);
        }
    }
});

        return router;
    };
