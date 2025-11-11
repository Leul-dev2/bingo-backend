const express = require('express');
const router = express.Router();
const User = require("../models/user");
const GameControl = require('../models/GameControl');
const GameCard = require("../models/GameCard");
const redis = require("../utils/redisClient");
const { v4: uuidv4 } = require('uuid');
const mongoose = require('mongoose');

// --- IMPORTANT: Define these default values before your router.post block ---
// NOTE: DEFAULT_GAME_TOTAL_CARDS should be 1 if each GameControl is one session.
// If it refers to the number of cards *per player*, adjust it. Assuming 1 for now.
const DEFAULT_GAME_TOTAL_CARDS = 1; 
const FALLBACK_STAKE_AMOUNT = 10;
const DEFAULT_CREATED_BY = 'System';
const DEFAULT_IS_ACTIVE = false;

router.post("/start", async (req, res) => {
    // 🆕 MODIFIED: Expecting 'cardIds' (an array) instead of 'cardId'
    const { gameId, telegramId, cardIds } = req.body;

    // --- VALIDATION: Ensure cardIds is a valid array of numbers ---
    if (!Array.isArray(cardIds) || cardIds.length === 0 || cardIds.some(isNaN)) {
        return res.status(400).json({ success: false, error: "Invalid or missing cardIds array." });
    }
    const numberOfCards = cardIds.length;
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
            // 1️⃣ Check for ACTIVE game first (remains the same)
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

            // 2️⃣ Check for INACTIVE lobby (remains the same)
            let lobbyDoc = await GameControl.findOne({
                gameId,
                isActive: false,
                endedAt: null
            }).session(session);

            // 3️⃣ Create lobby if it doesn't exist (remains the same)
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
            const singleCardStake = lobbyDoc.stakeAmount;
            // 🆕 CRITICAL: Calculate the total required stake
            const totalRequiredStake = singleCardStake * numberOfCards;


            // --- Enrollment Logic: Auto-join lobby ---
            const isMemberDB = lobbyDoc.players.some(player => player.telegramId === telegramId);
            if (!isMemberDB) {
                // 🆕 Step 6: Validate ALL cards
                const validCards = await GameCard.find({ 
                    gameId, 
                    cardId: { $in: cardIds }, // Find all cards by their IDs
                    isTaken: true, 
                    takenBy: telegramId 
                }).session(session);

                if (validCards.length !== numberOfCards) {
                    throw new Error("Invalid card selection. One or more cards are not properly selected by you or are unavailable.");
                }

                // 🆕 Step 7: Reserve the user's total stake
                // We use $inc to deduct the stake and $push to add a new reservation entry
                // IMPORTANT: Since multiple cards are selected, we must charge the balance here
                // and reserve the cards *within the user's document* or *within the GameControl player document*.
                // The existing logic only reserves for ONE game at a time. We need to reserve the *total amount*.
                
                // ⚠️ NOTE ON RESERVATION LOGIC ⚠️
                // The existing logic `$set: { reservedForGameId: gameId }` is a simple flag. 
                // For multi-card and multi-stake, you must DEDUCT the money now and use 
                // `reservedBalance` to hold the amount, or deduct from bonus first.
                // Assuming standard deduction from balance/bonus logic:

                let user = await User.findOne({ telegramId }).session(session);

                if (!user) {
                    throw new Error("User not found.");
                }

                // Determine if user can cover the total stake with bonus/real balance
                let amountToPay = totalRequiredStake;
                let bonusDeduction = 0;
                let balanceDeduction = 0;

                if (user.bonus_balance >= amountToPay) {
                    bonusDeduction = amountToPay;
                    amountToPay = 0;
                } else if (user.bonus_balance > 0) {
                    bonusDeduction = user.bonus_balance;
                    amountToPay -= user.bonus_balance;
                }

                if (amountToPay > 0 && user.balance >= amountToPay) {
                    balanceDeduction = amountToPay;
                    amountToPay = 0;
                }
                
                if (amountToPay > 0) {
                    throw new Error(`Insufficient balance. Required: ${totalRequiredStake}.`);
                }
                
                // Atomically deduct the balance/bonus and flag the user as reserved
                const updateObject = {
                    $inc: { 
                        balance: -balanceDeduction, 
                        bonus_balance: -bonusDeduction 
                    },
                    // ⚠️ Using GameSessionId for reservation flag, and adding the cards to the player's entry
                    $set: { 
                        reservedForGameId: currentSessionId,
                        // 🆕 Set the total amount reserved/paid for the session on the user
                        reservedStakeAmount: totalRequiredStake, 
                    } 
                };

                user = await User.findOneAndUpdate(
                    {
                        telegramId,
                        // Add check for already reserved, use the current session ID if reserved
                        $or: [
                            { reservedForGameId: { $exists: false } },
                            { reservedForGameId: null },
                            { reservedForGameId: "" },
                            { reservedForGameId: currentSessionId } // Allow multiple card selections if already reserved for this session
                        ],
                    },
                    updateObject,
                    { new: true, session }
                );

                if (!user) {
                    throw new Error("User is already reserved for another game.");
                }


                // 🆕 Step 8: Add the user to the GameControl document, including their cardIds
                await GameControl.updateOne(
                    { GameSessionId: currentSessionId },
                    { 
                        $addToSet: { 
                            players: { 
                                telegramId, 
                                status: 'connected',
                                cardIds: cardIds // 🆕 Store the selected card IDs here
                            } 
                        } 
                    },
                    { session }
                );

                // Step 9: Add user to Redis set (remains the same)
                await redis.sAdd(`gameRooms:${gameId}`, telegramId);

                // Step 10: Update prize pool and house profit
                await GameControl.updateOne(
                    { GameSessionId: currentSessionId },
                    {
                        $inc: {
                            // Assuming 10% house profit (adjust as necessary)
                            houseProfit: totalRequiredStake * 0.1, 
                            prizeAmount: totalRequiredStake * 0.9,
                        }
                    },
                    { session }
                );
            }

            responseSent = true;
            return res.status(200).json({
                success: true,
                gameId,
                telegramId,
                // 🆕 Update message to reflect multi-card selection
                message: `Joined game successfully with ${numberOfCards} card(s). Your stake has been deducted.`,
                GameSessionId: currentSessionId,
            });
        });
        } catch (error) {
            console.error("🔥 Game Start Error:", error);
            // ⚠️ CRITICAL: Handle the rollback of funds if the transaction failed after balance check but before commit.
            // Mongoose transaction will handle the rollback for the DB updates.
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