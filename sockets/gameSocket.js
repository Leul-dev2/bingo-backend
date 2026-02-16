const User = require("../models/user");
const GameControl = require("../models/GameControl");
const GameHistory = require("../models/GameHistory")
const Ledger = require("../models/Ledger");
const pushHistoryForAllPlayers = require("../utils/pushHistoryForAllPlayers");
const resetGame = require("../utils/resetGame");
const checkAndResetIfEmpty = require("../utils/checkandreset");
//const redis = require("../utils/redisClient");
const  syncGameIsActive = require("../utils/syncGameIsActive");
const GameCard = require('../models/GameCard'); // Your Mongoose models
const checkBingoPattern = require("../utils/BingoPatterns")
const resetRound = require("../utils/resetRound");
const SystemControl = require("../models/SystemControl");
const clearGameSessions = require('../utils/clearGameSessions'); // Adjust path as needed
const deleteCardsByTelegramId = require('../utils/deleteCardsByTelegramId');
const processWinnerAtomicCommit = require('../utils/processWinnerAtomicCommit');
const PlayerSession = require("../models/PlayerSession");
const GlobalGameStats = require('../models/GlobalGameStats');
const { findFieldsByValue } = require("../utils/redisHelpers");
const JoinedLobbyHandler = require("./JoinedLobby"); 
const cardSelectionHandler = require("./cardSelection");
const JoinedGameHandler = require("./JoinedGame");
const GameCountHandler = require("./gameCount");
const {pendingDisconnectTimeouts, ACTIVE_DISCONNECT_GRACE_PERIOD_MS, JOIN_GAME_GRACE_PERIOD_MS, ACTIVE_SOCKET_TTL_SECONDS} = require("../utils/timeUtils"); 
const mongoose = require('mongoose');

const { // <-- Add this line
    getGameActiveKey,
    getCountdownKey,
    getActiveDrawLockKey,
    getGameDrawStateKey,
    getGameDrawsKey,
    getGameSessionsKey,
    getGamePlayersKey, // You also use this
    getGameRoomsKey,   // You also use this
    getCardsKey,
    // Add any other specific key getters you defined in redisKeys.js
} = require("../utils/redisKeys"); // <-- Make sure the path is correct
const { Socket } = require("socket.io");
const gameCount = require("./gameCount");



module.exports = function registerGameSocket(io, redis) {
let gameSessions = {}; // Store game sessions: gameId -> [telegramId]
let gameSessionIds = {}; 
let userSelections = {}; // Store user selections: socket.id -> { telegramId, gameId }
let gameCards = {}; // Store game card selections: gameId -> { cardId: telegramId }
const gameDraws = {}; // { [gameId]: { numbers: [...], index: 0 } };
const countdownIntervals = {}; // { gameId: intervalId }
const drawIntervals = {}; // { gameId: intervalId }
const activeDrawLocks = {}; // Prevents multiple starts
const gameReadyToStart = {};
let drawStartTimeouts = {};
const gameIsActive = {};
const gamePlayers = {};
const gameRooms = {};
const joiningUsers = new Set();
const { v4: uuidv4 } = require("uuid");


 const state = {
  countdownIntervals: {},
  drawIntervals: {},
  drawStartTimeouts: {},
  activeDrawLocks: {},
  gameDraws: {},
  gameSessionIds: {},
  gameIsActive: {},
  gameReadyToStart: {},
};


 


 
  const subClient = redis.duplicate();

// We create an async block to handle the connection
(async () => {
    try {
        await subClient.connect();
        console.log("👂 Redis Subscriber connected: Listening for ADMIN_COMMANDS");
        
 await subClient.subscribe('ADMIN_COMMANDS', async (message) => {
    const action = JSON.parse(message);

    if (action.type === 'FORCE_TERMINATE') {
        // Ensure gameId is treated as a string for Socket.io room consistency
        const targetRoom = String(action.gameId);
        
        console.log(`🚫 Termination signal for Room: ${targetRoom}`);

        // 1. STOP THE DRAWING TIMER IMMEDIATELY
        if (state.drawIntervals[targetRoom]) {
            clearInterval(state.drawIntervals[targetRoom]);
            delete state.drawIntervals[targetRoom];
        }

        // 2. EMIT FIRST
        io.to(targetRoom).emit('force_game_end', {
            message: "The game session has been terminated by an administrator."
        });

        // 3. DELAY THE KICK & CLEANUP
        // This gives the frontend 1 second to receive the message and show the alert
        setTimeout(async () => {
            await fullGameCleanup(targetRoom, redis, state);
            io.in(targetRoom).socketsLeave(targetRoom);
            console.log(`🧹 Cleanup complete for ${targetRoom}`);
        }, 1000); 
    }
  });
    } catch (err) {
        console.error("❌ Redis Subscriber failed:", err);
    }
 })();




  io.on("connection", (socket) => {
    //   console.log("🟢 New client connected");
    //   console.log("Client connected with socket ID:", socket.id);
    //   console.log("Connected sockets 🟢🟢🟩:", io.sockets.sockets.size);


    // setInterval(() => {
    // const used = process.memoryUsage();
    // console.log("Heap 🚀🗑️🚀:", (used.heapUsed / 1024 / 1024).toFixed(2), "MB");
    // }, 60000);


    // User joins a game lobby phase
     JoinedLobbyHandler(socket, io, redis);
     cardSelectionHandler(socket, io, redis);
     JoinedGameHandler(socket, io, redis);
     GameCountHandler(socket, io, redis, state);






    // --- UPDATED: socket.on("joinGame") ---
   

 
    const clearUserReservations = async (playerIds) => {
        if (!playerIds || playerIds.length === 0) return;

        try {
            await User.updateMany(
                { telegramId: { $in: playerIds } },
                { $unset: { reservedForGameId: "" } }
            );
            console.log(`✅ Reservations cleared for ${playerIds.length} players.`);
        } catch (error) {
            console.error("❌ Error clearing user reservations:", error);
        }
    };

    // Your minimum player counts



    //check winner

    socket.on("checkWinner", async ({ telegramId, gameId, GameSessionId, cartelaId, selectedNumbers }) => {
        console.time(`⏳checkWinner_${telegramId}`);

      try {
        const selectedSet = new Set((selectedNumbers || []).map(Number));
        const numericCardId = Number(cartelaId);
        if (isNaN(numericCardId)) {
          return socket.emit("winnerError", { message: "Invalid card ID." });
        }

        // --- 1️⃣ Fetch drawn numbers from Redis (Non-redundant fetch) ---
        const drawnNumbersRaw = await redis.lRange(`gameDraws:${GameSessionId}`, 0, -1);
        if (!drawnNumbersRaw?.length) return socket.emit("winnerError", { message: "No numbers drawn yet." });
        const drawnNumbersArray = drawnNumbersRaw.map(Number);
        const lastTwoDrawnNumbers = drawnNumbersArray.slice(-2);
        const drawnNumbers = new Set(drawnNumbersArray);

        // --- 2️⃣ Fetch cardData once (Cache data for processor) ---
        const cardData = await GameCard.findOne({ gameId, cardId: numericCardId });
        if (!cardData) return socket.emit("winnerError", { message: "Card not found." });

        // --- 3️⃣ Check bingo pattern in memory ---
        const pattern = checkBingoPattern(cardData.card, drawnNumbers, selectedSet);
        if (!pattern.some(Boolean)) return socket.emit("winnerError", { message: "No winning pattern." });

        // --- 4️⃣ Check recent numbers in pattern (Critical game rule validation) ---
        const flatCard = cardData.card.flat();
        const isRecentNumberInPattern = lastTwoDrawnNumbers.some(num =>
          // Checks if the recent number 'num' is present in the card and corresponds to a winning cell (pattern[i] === true)
          flatCard.some((n, i) => pattern[i] && n === num)
        );
        if (!isRecentNumberInPattern) {
          // Provides debugging info back to the client/logs on failure
          return socket.emit("bingoClaimFailed", {
            message: "Winning pattern not completed by recent numbers.",
            telegramId, gameId, cardId: cartelaId, card: cardData.card, lastTwoNumbers: lastTwoDrawnNumbers, selectedNumbers
          });
        }

        // --- 5️⃣ Acquire winner lock in Redis (Minimize DB calls inside lock) ---
        const winnerLockKey = `winnerLock:${GameSessionId}`;
        // EX: 30 seconds expiry (Increased for safety), NX: Only set if Not eXists
        const lockAcquired = await redis.set(winnerLockKey, telegramId, { NX: true, EX: 30 });
        if (!lockAcquired) return; // Someone else won and acquired the lock first

        // --- 6️⃣ Call optimized winner processor, passing cached data ---
        await processWinner({
          telegramId, gameId, GameSessionId, cartelaId, io, selectedSet, state, redis, cardData, drawnNumbersRaw, winnerLockKey
        });

      } catch (error) {
        console.error("checkWinner error:", error);
        socket.emit("winnerError", { message: "Internal error." });
      } finally {
        console.timeEnd(`⏳checkWinner_${telegramId}`);
      }
    });

// --------------------- Optimized Winner Processor ---------------------
// This function addresses all five optimization points: parallelism, caching, batching, and cleanup.
   async function processWinner({ telegramId, gameId, GameSessionId, cartelaId, io, selectedSet, state, redis, cardData, drawnNumbersRaw, winnerLockKey }) {
        const strGameId = String(gameId);
        const strGameSessionId = String(GameSessionId);

        // --- 1️⃣ Initial Data Fetching and Validation (PRE-COMMIT) ---
        // 🟢 CORRECTION 1: Use .select('players...') and .lean() to fetch the definitive list of paid participants.
        const [gameControl, winnerUser] = await Promise.all([
            GameControl.findOne({ GameSessionId: strGameSessionId })
                       .select('players prizeAmount houseProfit stakeAmount totalCards')
                       .lean(),
            User.findOne({ telegramId }),
        ]);

        if (!gameControl || !winnerUser) {
            console.warn(`🚫 Missing GameControl or WinnerUser for session ${strGameSessionId}. Aborting.`);
            await redis.del(winnerLockKey); // Release lock
            return;
        }

        // --- 2️⃣ Calculate Dynamic Values (PRE-COMMIT) ---
        // The GameControl document must contain the 'players' array for accurate loser tracking.
        const { prizeAmount, houseProfit, stakeAmount, totalCards: playerCount } = gameControl;
        const board = cardData.card;
        
        // Assumes checkBingoPattern is a globally available helper function
        const winnerPattern = checkBingoPattern(board, new Set(drawnNumbersRaw.map(Number)), selectedSet); 
        const callNumberLength = drawnNumbersRaw ? drawnNumbersRaw.length : 0; 
        
        // Consolidated data package for the atomic commit and deferred tasks
        const winnerData = { 
            telegramId: Number(telegramId), // Ensure type consistency
            strGameId, 
            strGameSessionId, 
            prizeAmount, 
            houseProfit, 
            stakeAmount, 
            cartelaId: Number(cartelaId),
            callNumberLength,
        };

        // --- 3️⃣ Broadcast winner information (IMMEDIATE RESPONSE) ---
        io.to(strGameId).emit("winnerConfirmed", { 
            winnerName: winnerUser.username || "Unknown", 
            prizeAmount, 
            playerCount, 
            boardNumber: cartelaId, 
            board,
            winnerPattern, 
            telegramId, 
            gameId: strGameId, 
            GameSessionId: strGameSessionId 
        });
        io.to(strGameId).emit("gameEnded", { message: "Winner found, game ended." });

          const winnerId = telegramId;
            // --- 4️⃣ Atomic Financial Commit & State Transition (CRITICAL) ---
            try {
          // Pass the necessary IO and Redis clients for post-commit cleanup (not inside the transaction)
             await processWinnerAtomicCommit(winnerData, winnerUser, io, redis, state); 
             await pushHistoryForAllPlayers(strGameSessionId, strGameId, redis);
            
            // Release the winner lock immediately after the atomic commit succeeds
            await redis.del(winnerLockKey); 

        } catch (error) {
            console.error("🔥 processWinner execution error:", error);
            // Ensure lock is released quickly if the atomic commit failed
            await redis.del(winnerLockKey).catch(err => console.error("Lock release error:", err));
        }
    }




    // ✅ Handle playerLeave event
    socket.on("playerLeave", async ({ gameId, GameSessionId, telegramId }, callback) => {
        const strTelegramId = String(telegramId);
        const strGameId = String(gameId);
        console.log(`🚪 Player ${telegramId} is leaving game ${gameId} ${GameSessionId}`);

        try {
            // --- Release the player's balance reservation lock in the database ---
            const userUpdateResult = await User.updateOne(
                { telegramId: strTelegramId, reservedForGameId: strGameId },
                { $unset: { reservedForGameId: "" } }
            );

            if (userUpdateResult.modifiedCount > 0) {
                console.log(`✅ Balance reservation lock for player ${telegramId} released.`);
            } else {
                console.log(`⚠️ No balance reservation lock found for player ${telegramId}.`);
            }

        await PlayerSession.updateOne(
            {
                GameSessionId: GameSessionId,
                telegramId: strTelegramId,
            },
            {
                $set: { status: 'disconnected' }
            }
        );

        console.log(`✅ PlayerSession record for ${strTelegramId} updated to disconnected status.`);


            // --- Remove from Redis sets and hashes ---
            await Promise.all([
                redis.sRem(`gameSessions:${gameId}`, strTelegramId),
                redis.sRem(`gameRooms:${gameId}`, strTelegramId),
            ]);


                // --- RELEASE ALL PLAYER CARDS ---
        const gameCardsKey = `gameCards:${gameId}`;
        const strTg = String(telegramId).trim();

        // Step 1: Fetch cards before release
        let allGameCards = await redis.hGetAll(gameCardsKey);

        // Step 2: Find all belonging to the player
        let cardsToRelease = Object.entries(allGameCards)
            .filter(([_, ownerId]) => String(ownerId).trim() == strTg)
            .map(([cardId]) => cardId);

            // Step 3: Release all those cards
            if (cardsToRelease.length > 0) {
                console.log(`🧹 Releasing ${cardsToRelease.length} cards for ${strTg}: ${cardsToRelease.join(', ')}`);

                await redis.hDel(gameCardsKey, ...cardsToRelease);

                await GameCard.updateMany(
                    { gameId: strGameId, cardId: { $in: cardsToRelease.map(Number) } },
                    { $set: { isTaken: false, takenBy: null } }
                );

                // Step 4: Double-check Redis (handle race condition)
                const verifyGameCards = await redis.hGetAll(gameCardsKey);
                const leftovers = Object.entries(verifyGameCards)
                    .filter(([_, ownerId]) => String(ownerId).trim() == strTg)
                    .map(([cardId]) => cardId);

                if (leftovers.length > 0) {
                    console.log(`⚠️ Found leftover cards after release, deleting again: ${leftovers.join(', ')}`);
                    await redis.hDel(gameCardsKey, ...leftovers);
                }

                io.to(gameId).emit("cardsReleased", {
                    cardIds: [...cardsToRelease, ...leftovers],
                    telegramId: strTg,
                });
            }


            // --- Remove userSelections entries by both socket.id and telegramId after usage ---
            await Promise.all([
                redis.hDel("userSelections", socket.id),
                redis.hDel("userSelections", strTelegramId), // Legacy
                redis.hDel("userSelectionsByTelegramId", strTelegramId), // Legacy
                redis.sRem(getGameRoomsKey(gameId), strTelegramId),
                // deleteCardsByTelegramId(strGameId, strTelegramId, redis), // This is redundant now
                redis.del(`activeSocket:${strTelegramId}:${socket.id}`),
                redis.del(`countdown:${strGameId}`),
            ]);

            // Emit updated player count
            const playerCount = await redis.sCard(`gameRooms:${gameId}`) || 0;
            io.to(gameId).emit("playerCountUpdate", { gameId, playerCount });
            await checkAndResetIfEmpty(gameId, GameSessionId, telegramId,  socket, io, redis, state);

            if (callback) callback();
        } catch (error) {
            console.error("❌ Error handling playerLeave:", error);
            if (callback) callback();
        }
    });






// Handle disconnection events
// --- REFACTORED: socket.on("disconnect") ---
 // A helper function for safe JSON parsing
    const safeJsonParse = (rawPayload, key, socketId) => {
        try {
            if (rawPayload) {
                return JSON.parse(rawPayload);
            }
        } catch (e) {
            console.error(`❌ Error parsing payload for ${key} and socket ${socketId}: ${e.message}. Cleaning up.`);
        }
        return null;
    };

// A map to store pending disconnect timeouts, keyed by a unique identifier.

     socket.on("disconnect", async (reason) => {
        console.log(`🔴 Client disconnected: ${socket.id}, Reason: ${reason}`);

        try {
            const [userSelectionPayloadRaw, joinGamePayloadRaw] = await redis.multi()
                .hGet("userSelections", socket.id)
                .hGet("joinGameSocketsInfo", socket.id)
                .exec();

            let userPayload = null;
            let disconnectedPhase = null;
            // ✅ CORRECTION: Initialize GameSessionId here to ensure it's captured correctly.
            let strGameSessionId = 'NO_SESSION_ID';

            // ✅ CORRECTION: Prioritize the 'joinGame' payload as it contains the critical GameSessionId.
            if (joinGamePayloadRaw) {
                userPayload = safeJsonParse(joinGamePayloadRaw, "joinGameSocketsInfo", socket.id);
                if (userPayload) {
                    disconnectedPhase = userPayload.phase || 'joinGame';
                    strGameSessionId = userPayload.GameSessionId || strGameSessionId;
                } else {
                    await redis.hDel("joinGameSocketsInfo", socket.id); // Clean up corrupted data
                }
            }
            
            // Fallback to the 'lobby' payload if no 'joinGame' info was found.
            if (!userPayload && userSelectionPayloadRaw) {
                userPayload = safeJsonParse(userSelectionPayloadRaw, "userSelections", socket.id);
                if (userPayload) {
                    disconnectedPhase = userPayload.phase || 'lobby';
                } else {
                    await redis.hDel("userSelections", socket.id); // Clean up corrupted data
                }
            }

            if (!userPayload || !userPayload.telegramId || !userPayload.gameId) {
                console.log("❌ No relevant user session info found for this disconnected socket. Skipping cleanup.");
                return;
            }

            const strTelegramId = String(userPayload.telegramId);
            const strGameId = String(userPayload.gameId);

            console.log(`[DISCONNECT] Processing disconnect for User: ${strTelegramId}, Game: ${strGameId}, Phase: ${disconnectedPhase}, Session: ${strGameSessionId}`);

            await redis.del(`activeSocket:${strTelegramId}:${socket.id}`);

            const allActiveSocketKeysForUser = await redis.keys(`activeSocket:${strTelegramId}:*`);
            if (allActiveSocketKeysForUser.length > 0) {
                 console.log(`[DISCONNECT] User ${strTelegramId} still has other active sockets. No cleanup timer started.`);
                 return; // User has other connections, so no need to start a cleanup timer.
            }
            
            const timeoutKeyForPhase = `${strTelegramId}:${strGameId}:${disconnectedPhase}`;
            if (pendingDisconnectTimeouts.has(timeoutKeyForPhase)) {
                clearTimeout(pendingDisconnectTimeouts.get(timeoutKeyForPhase));
                pendingDisconnectTimeouts.delete(timeoutKeyForPhase);
            }

            let gracePeriodDuration = 0;
            if (disconnectedPhase === 'lobby') {
                gracePeriodDuration = ACTIVE_DISCONNECT_GRACE_PERIOD_MS;
            } else if (disconnectedPhase === 'joinGame') {
                gracePeriodDuration = JOIN_GAME_GRACE_PERIOD_MS;
            }

            if (gracePeriodDuration > 0) {
                const timeoutId = setTimeout(async () => {
                    try {
                        const cleanupJob = JSON.stringify({
                            telegramId: strTelegramId,
                            gameId: strGameId,
                            gameSessionId: strGameSessionId, // ✅ CORRECTION: This is now reliably sourced
                            phase: disconnectedPhase,
                            timestamp: new Date().toISOString()
                        });

                        await redis.lPush('disconnect-cleanup-queue', cleanupJob);
                        console.log(`[DEFERRED] Pushed cleanup job to queue for User: ${strTelegramId}, Phase: ${disconnectedPhase}`);

                    } catch (e) {
                        console.error(`❌ Error pushing disconnect job to queue for ${strTelegramId}:`, e);
                    } finally {
                        pendingDisconnectTimeouts.delete(timeoutKeyForPhase);
                    }
                }, gracePeriodDuration);

                pendingDisconnectTimeouts.set(timeoutKeyForPhase, timeoutId);
                console.log(`🕒 Starting ${gracePeriodDuration / 1000}s grace period for ${strTelegramId} in phase '${disconnectedPhase}'.`);
            }
        } catch (e) {
            console.error(`❌ CRITICAL ERROR in disconnect handler for socket ${socket.id}:`, e);
        }
    });
  });
};





         