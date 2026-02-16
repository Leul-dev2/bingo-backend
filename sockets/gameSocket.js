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
const checkWinnerHandler = require("./checkWinner");
const playerLeaveHandler = require("./playerLeave");
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
     checkWinnerHandler(socket, io, redis, state);
     playerLeaveHandler(socket, io, redis);






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





         