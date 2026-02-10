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
            const { gameId, telegramId, cardIds } = req.body;
            const strGameId = String(gameId);
            const control = await SystemControl.getSingleton();

            // 1. Start the MongoDB Session for Transaction
            const session = await mongoose.startSession();
            
            try {
                let lobbyDoc;
                let responseBody;
                let statusCode = 200;

              if (!control.allowNewGames) {
                return res.status(403).json({
                    success: false,
                    message: "New game creation is currently disabled for maintenance."
                });
                }

                // 🔐 Step 1: Block joins during "game starting" phase
                const gameStartingKey = `gameStarting:${strGameId}`;
                const isStarting = await redisClient.get(gameStartingKey);
                if (isStarting) {
                    return res.status(400).json({
                        error: "🚫 Game is currently starting."
                    });
                }

                // --- NEW: Add validation for the cardIds array itself ---
                if (!cardIds || !Array.isArray(cardIds) || cardIds.length === 0 || cardIds.length > 2) {
                    return res.status(400).json({ error: "You must select 1 or 2 cards." });
                }

                await session.withTransaction(async () => {
                    
                    // A. ATTEMPT TO FIND OR CREATE THE SINGLE LOBBY/GAME CONTROL
                    
                    // 2. Find the current game (Lobby or Active).
                    const currentControl = await GameControl.findOne({ gameId: strGameId, endedAt: null }).session(session);

                    if (currentControl) {
                        // Game/Lobby found.
                        if (currentControl.isActive) {
                            // Game is active.
                            throw { 
                                message: "🚫 A game is already running.", 
                                statusCode: 400, 
                                body: { GameSessionId: currentControl.GameSessionId } 
                            };
                        }
                        // Lobby exists.
                        lobbyDoc = currentControl;

                    } else {
                        // No current game/lobby found. Attempt to CREATE the NEW LOBBY.
                        try {
                            lobbyDoc = (await GameControl.create([{
                                GameSessionId: uuidv4(),
                                gameId: strGameId,
                                isActive: false, // LOBBY STATE
                                createdBy: DEFAULT_CREATED_BY,
                                stakeAmount: Number(strGameId) > 0 ? Number(strGameId) : FALLBACK_STAKE_AMOUNT,
                                totalCards: DEFAULT_GAME_TOTAL_CARDS,
                                prizeAmount: 0,
                                houseProfit: 0,
                                createdAt: new Date(),
                                endedAt: null,
                            }], { session }))[0];
                        } catch (e) {
                            if (e.code === 11000) {
                                lobbyDoc = await GameControl.findOne({ gameId: strGameId, endedAt: null }).session(session);
                                if (!lobbyDoc) {
                                    throw new Error("Could not retrieve lobby after concurrent creation attempt.");
                                }
                            } else {
                                throw e;
                            }
                        }
                    }
                    
                    // B. VALIDATE AND ADD PLAYER TO THE SINGLE LOBBY DOCUMENT
                    
                    // 3. Validate the card (Ensure card is reserved for this user)
                    const cards = await GameCard.find({ gameId: strGameId, cardId: { $in: cardIds }, isTaken: true, takenBy: Number(telegramId) }).session(session);
                    
                    // --- FIX 1: Validate card COUNT ---
                    if (cards.length !== cardIds.length) {
                    throw new Error("Invalid card or card not reserved by you.");
                    }
                    
                    // --- FIX 2: Calculate total stake ---
                    const totalStakeToReserve = lobbyDoc.stakeAmount * cardIds.length;

                    // 4. Reserve the user's stake AND check if they are already reserved for this game.
                    const user = await User.findOneAndUpdate(
                        {
                            telegramId,
                            $or: [
                                { reservedForGameId: { $exists: false } },
                                { reservedForGameId: null },
                                { reservedForGameId: "" },
                                { reservedForGameId: strGameId } 
                            ],
                        $or: [ // This block is now correct because totalStakeToReserve is defined
                                { bonus_balance: { $gte: totalStakeToReserve } }, 
                                { balance: { $gte: totalStakeToReserve } } 
                            ]
                        },
                            { $set: { reservedForGameId: strGameId } },
                            { new: true, session }
                    );

                    if (!user) {
                        throw new Error("Insufficient balance or you are already in another game.");
                    }

                    // 🛑 SECONDARY FIX: Defensive Check
                    const finalControlCheck = await GameControl.findOne(
                        { GameSessionId: lobbyDoc.GameSessionId, endedAt: null, isActive: true }
                    ).session(session);
                    
                    if (finalControlCheck) {
                        throw { 
                            message: "🚫 A game is already running.", 
                            statusCode: 400, 
                            body: { GameSessionId: lobbyDoc.GameSessionId } 
                        };
                    }
                    
                    // 5. CRITICAL FIX: Create or update the PlayerSession record.
                    const playerSession = await PlayerSession.findOneAndUpdate(
                        { GameSessionId: lobbyDoc.GameSessionId, telegramId: Number(telegramId) },
                        { 
                            $set: { cardIds: cardIds, status: 'connected' }, // This was already correct
                            $setOnInsert: { joinedAt: new Date() } 
                        },
                        { new: true, upsert: true, session }
                    );

                    // 6. Set response body
                    responseBody = { success: true, message: "Joined game successfully. Your stake has been reserved.", GameSessionId: lobbyDoc.GameSessionId };

                }); // END TRANSACTION COMMIT

                // 7. POST-COMMIT ACTIONS: Redis update
                await redisClient.sAdd(`gameRooms:${strGameId}`, telegramId); 
                
                return res.status(statusCode).json(responseBody);

            } catch (error) {
                // ... (rest of your error handling is fine) ...
                if (session.inTransaction()) {
                    await session.abortTransaction();
                }
                if (error.statusCode === 400 && error.body) {
                    return res.status(error.statusCode).json(error.body);
                }
                if (error.code === 11000) {
                    return res.status(409).json({ error: "Lobby is being created. Please try again in a moment." });
                }
                const code = error.statusCode || 400;
                const body = { error: error.message || "An internal error occurred." };
                return res.status(code).json(body);
                
            }finally {
            await session.endSession();
        }
        });

        return router;
    };
