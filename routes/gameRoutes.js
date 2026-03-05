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
        return res.status(403).json({ success: false, message: "Currently disabled for maintenance." });
    }

    const gameStartingKey = `gameStarting:${strGameId}`;
    if (await redisClient.get(gameStartingKey)) {
        return res.status(400).json({ error: "🚫 Game is currently starting." });
    }

    // ── ATOMIC CREATOR ELECTION (Redis decides in <2ms) ──
    const sessionKey = `lobby:session:${strGameId}`;
    let GameSessionId = null;
    const mongoSession = await mongoose.startSession();

    try {
        GameSessionId = await redisClient.get(sessionKey);

        if (!GameSessionId) {
            GameSessionId = uuidv4();
            const created = await redisClient.set(sessionKey, GameSessionId, { NX: true, EX: 25 });

            if (created === 'OK') {
                // ONLY THIS PLAYER creates the lobby
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
                console.log(`🏆 Lobby created by ${telegramId} → ${GameSessionId}`);
            } else {
                // Another player just created it
                GameSessionId = await redisClient.get(sessionKey);
            }
        }

        // ── EVERY PLAYER joins the SAME game ──
        await mongoSession.withTransaction(async () => {
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

            await PlayerSession.findOneAndUpdate(
                { GameSessionId, telegramId: Number(telegramId) },
                {
                    $set: { username: username || `User ${telegramId}`, cardIds, status: 'connected' },
                    $setOnInsert: { joinedAt: new Date() }
                },
                { upsert: true, session: mongoSession }
            );
        });

        await redisClient.sAdd(`gameRooms:${strGameId}`, String(telegramId));

        return res.json({
            success: true,
            message: "Joined game successfully. Your stake has been reserved.",
            GameSessionId
        });

    } catch (error) {
        console.error("Start error:", error.message);
        if (GameSessionId) await redisClient.del(sessionKey).catch(() => {});
        return res.status(400).json({ error: "Please try again" }); // only real errors (balance, etc.)
    } finally {
        await mongoSession.endSession();
        // cleanup after 25s
        setTimeout(() => redisClient.del(sessionKey), 25000);
    }
});

        return router;
    };
