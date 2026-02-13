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
const pendingDisconnectTimeouts = new Map(); // Key: `${telegramId}:${gameId}`, Value: setTimeout ID
const ACTIVE_DISCONNECT_GRACE_PERIOD_MS = 1 * 1000; // For card selection lobby (10 seconds)
const JOIN_GAME_GRACE_PERIOD_MS = 2 * 1000; // For initial join/live game phase (5 seconds)
const ACTIVE_SOCKET_TTL_SECONDS = 60 * 3;


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


   async function fullGameCleanup(gameId, redis, state) {
        console.log("fullGameCleanup 🔥🔥🔥");
        delete state.activeDrawLocks[gameId];
        await redis.del(getActiveDrawLockKey(gameId));
        await syncGameIsActive(gameId, false, redis);
        if (state.countdownIntervals[gameId]) { clearInterval(state.countdownIntervals[gameId]); delete state.countdownIntervals[gameId]; }
     }


 
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
    socket.on("userJoinedGame", async ({ telegramId, gameId }) => {
        console.log("userJoined invoked");
        const strGameId = String(gameId);
        const strTelegramId = String(telegramId);

        try {
            const userSelectionKey = `userSelections`; // Stores selection per socket.id
            const userOverallSelectionKey = `userSelectionsByTelegramId`; // Stores the user's *overall* selected card by telegramId
            const gameCardsKey = `gameCards:${strGameId}`;
            const sessionKey = `gameSessions:${strGameId}`; // Card selection lobby (unique players)
            const gamePlayersKey = `gamePlayers:${strGameId}`; // Overall game players (unique players across all game states)

            console.log(`Backend: Processing userJoinedGame for Telegram ID: ${strTelegramId}, Game ID: ${strGameId}`);

            // --- Step 1: Handle Disconnect Grace Period Timer Cancellation ---
            const timeoutKey = `${strTelegramId}:${strGameId}`;
            if (pendingDisconnectTimeouts.has(timeoutKey)) {
                clearTimeout(pendingDisconnectTimeouts.get(timeoutKey));
                pendingDisconnectTimeouts.delete(timeoutKey);
                console.log(`✅ User ${strTelegramId} reconnected to game ${strGameId} within grace period. Cancelled full disconnect cleanup.`);
            } else {
                console.log(`🆕 User ${strTelegramId} joining game ${strGameId}. No pending disconnect timeout found (or it already expired).`);
            }

            // --- IMPORTANT: Clean up any residual 'joinGame' phase info for this socket ---
            // This handles the transition from 'joinGame' phase to 'lobby' phase for the same socket
            await redis.hDel(`joinGameSocketsInfo`, socket.id);
            console.log(`🧹 Cleaned up residual 'joinGameSocketsInfo' for socket ${socket.id} as it's now in 'lobby' phase.`);


            // --- Step 2: Determine Current Card State for Reconnecting Player ---
            let currentHeldCardId = null;
            let currentHeldCard = null;

            const userOverallSelectionRaw = await redis.hGet(userOverallSelectionKey, strTelegramId);
            if (userOverallSelectionRaw) {
                const overallSelection = JSON.parse(userOverallSelectionRaw);
                if (String(overallSelection.gameId) === strGameId && overallSelection.cardId !== null) {
                    const cardOwner = await redis.hGet(gameCardsKey, String(overallSelection.cardId));
                    if (cardOwner === strTelegramId) {
                        currentHeldCardId = overallSelection.cardId;
                        currentHeldCard = overallSelection.card;
                        console.log(`✅ User ${strTelegramId} reconnected with previously held card ${currentHeldCardId} for game ${strGameId}.`);
                    } else {
                        console.log(`⚠️ User ${strTelegramId} overall selection for card ${overallSelection.cardId} in game ${strGameId} is no longer valid (card not taken by them in gameCards). Cleaning up stale entry.`);
                        await redis.hDel(userOverallSelectionKey, strTelegramId);
                    }
                } else {
                    console.log(`ℹ️ User ${strTelegramId} had overall selection, but for a different game or no card. No card restored for game ${strGameId}.`);
                }
            } else {
                console.log(`ℹ️ No overall persisted selection found for ${strTelegramId}. User will join without a pre-selected card.`);
            }

            // --- Step 3: Set up new socket and persist its specific selection state ---
            await redis.set(`activeSocket:${strTelegramId}:${socket.id}`, '1', 'EX', ACTIVE_SOCKET_TTL_SECONDS);
            socket.join(strGameId);

            await redis.hSet(userSelectionKey, socket.id, JSON.stringify({
                telegramId: strTelegramId,
                gameId: strGameId,
                cardId: currentHeldCardId,
                card: currentHeldCard,
                phase: 'lobby' // Indicate this socket belongs to the 'lobby' phase
            }));
            console.log(`Backend: Socket ${socket.id} for ${strTelegramId} set up with cardId: ${currentHeldCardId || 'null'} in 'lobby' phase.`);

            // --- Step 4: Add user to Redis Sets (Lobby and Overall Game Players) ---
            await redis.sAdd(sessionKey, strTelegramId);
            await redis.sAdd(gamePlayersKey, strTelegramId);
            console.log(`Backend: Added ${strTelegramId} to Redis SETs: ${sessionKey} and ${gamePlayersKey}.`);

            // --- Step 5: Broadcast Current Lobby State to All Players in the Game ---
            const numberOfPlayersInLobby = await redis.sCard(sessionKey);
            console.log(`Backend: Calculated numberOfPlayers for ${sessionKey} (card selection lobby): ${numberOfPlayersInLobby}`);

            io.to(strGameId).emit("gameid", {
                gameId: strGameId,
                numberOfPlayers: numberOfPlayersInLobby,
            });
            console.log(`Backend: Emitted 'gameid' to room ${strGameId} with numberOfPlayers: ${numberOfPlayersInLobby}`);

            // --- Step 6: Send Initial Card States to the *Joining Client Only* ---
            const allTakenCardsData = await redis.hGetAll(gameCardsKey);
            const initialCardsState = {};
            for (const cardId in allTakenCardsData) {
                initialCardsState[cardId] = {
                    cardId: Number(cardId),
                    takenBy: allTakenCardsData[cardId],
                    isTaken: true
                };
            }
            socket.emit("initialCardStates", { takenCards: initialCardsState });
            console.log(`Backend: Sent 'initialCardStates' to ${strTelegramId} for game ${strGameId}. Total taken cards: ${Object.keys(initialCardsState).length}`);

        } catch (err) {
            console.error("❌ Error in userJoinedGame:", err);
            socket.emit("joinError", {
                message: "Failed to join game. Please refresh or retry.",
            });
        }
    });


    socket.on("cardSelected", async (data) => {
        // --- NEW ---: Destructure the array and map from the frontend
        const { telegramId, gameId, cardIds, cardsData, requestId } = data;

        // --- 1. Data Sanitization & Key Preparation ---
        const strTelegramId = String(telegramId);
        const strGameId = String(gameId);
        const userActionLockKey = `lock:userAction:${strGameId}:${strTelegramId}`;
        
        // Redis keys
        const gameCardsKey = `gameCards:${strGameId}`;
        const userSelectionsKey = `userSelections`; // For the socket
        const userSelectionsByTelegramIdKey = `userSelectionsByTelegramId`; // Legacy
        const userLastRequestIdKey = `userLastRequestId`;

        // --- FIX ---: Define cardLockKeys in the outer scope
        let cardLockKeys = [];

        // --- 2. Acquire User-Level Lock ---
        const userLock = await redis.set(userActionLockKey, requestId, "NX", "EX", 10);
        if (!userLock) {
            return socket.emit("cardError", {
                message: "⏳ Your previous action is still processing. Please wait a moment.",
                requestId
            });
        }

        try {
            // --- 3. Validate Input ---
            if (!Array.isArray(cardIds) || cardIds.length > 2) {
                throw new Error("Invalid card selection. Must be an array with 0-2 cards.");
            }
            const newCardIdSet = new Set(cardIds.map(String));

            // --- 4. Get Current State from Redis ---
            const allGameCards = await redis.hGetAll(gameCardsKey);
            const myOldCardIds = [];
            for (const [cardId, ownerId] of Object.entries(allGameCards)) {
                if (ownerId === strTelegramId) {
                    myOldCardIds.push(cardId);
                }
            }
            const myOldCardIdSet = new Set(myOldCardIds);

            // --- 5. Determine Cards to Add and Release ---
            const cardsToAdd = [];
            for (const cardId of newCardIdSet) {
                if (!myOldCardIdSet.has(cardId)) {
                    cardsToAdd.push(cardId);
                }
            }

            const cardsToRelease = [];
            for (const cardId of myOldCardIdSet) {
                if (!newCardIdSet.has(cardId)) {
                    cardsToRelease.push(cardId);
                }
            }
            
            // --- 6. Check for Conflicts (Cards to Add) ---
            // --- FIX ---: Assign value to the outer-scoped variable
            cardLockKeys = cardsToAdd.map(cardId => `lock:card:${strGameId}:${cardId}`);
            let locksAcquired = true;

            if (cardsToAdd.length > 0) {
                for (const cardId of cardsToAdd) {
                    const existingOwnerId = allGameCards[cardId];
                    if (existingOwnerId && existingOwnerId !== strTelegramId) {
                        throw new Error(`Card ${cardId} is already taken.`);
                    }
                    
                    const cardLock = await redis.set(`lock:card:${strGameId}:${cardId}`, strTelegramId, "NX", "EX", 10);
                    if (!cardLock) {
                        locksAcquired = false;
                        break; 
                    }
                }
            }

            if (!locksAcquired) {
                throw new Error("One of your selected cards is currently being claimed. Please try again.");
            }

            // --- 7. Perform Atomic Updates ---
            const dbUpdatePromises = [];
            const redisMulti = redis.multi();

            // A) Release old cards
            if (cardsToRelease.length > 0) {
                dbUpdatePromises.push(
                    GameCard.updateMany(
                        { gameId: strGameId, cardId: { $in: cardsToRelease.map(Number) } },
                        { $set: { isTaken: false, takenBy: null } }
                    )
                );
                redisMulti.hDel(gameCardsKey, ...cardsToRelease);
            }

            // B) Add new cards
            if (cardsToAdd.length > 0) {
                for (const cardId of cardsToAdd) {
                    const strCardId = String(cardId);
                    const cardGrid = cardsData[strCardId];
                    if (!cardGrid) {
                        throw new Error(`Missing card data for card ${strCardId}`);
                    }
                    const cleanCard = cardGrid.map(row => row.map(c => (c === "FREE" ? 0 : Number(c))));

                    dbUpdatePromises.push(
                        GameCard.updateOne(
                            { gameId: strGameId, cardId: Number(strCardId) },
                            { $set: { card: cleanCard, isTaken: true, takenBy: strTelegramId } },
                            { upsert: true }
                        )
                    );
                    redisMulti.hSet(gameCardsKey, strCardId, strTelegramId);
                }
            }

            // C) Update session/legacy keys
            const lastCardId = cardIds.length > 0 ? cardIds[cardIds.length - 1] : null;
            if (lastCardId) {
                const lastCardGrid = cardsData[lastCardId];
                const cleanCard = lastCardGrid ? lastCardGrid.map(row => row.map(c => (c === "FREE" ? 0 : Number(c)))) : [];
                const selectionData = JSON.stringify({
                    telegramId: strTelegramId,
                    cardId: String(lastCardId),
                    card: cleanCard,
                    gameId: strGameId
                });
                redisMulti.hSet(userSelectionsKey, socket.id, selectionData);
                redisMulti.hSet(userSelectionsByTelegramIdKey, strTelegramId, selectionData);
            } else {
                redisMulti.hDel(userSelectionsKey, socket.id);
                redisMulti.hDel(userSelectionsByTelegramIdKey, strTelegramId);
            }
            redisMulti.hSet(userLastRequestIdKey, strTelegramId, requestId);
            
            await Promise.all([
                ...dbUpdatePromises,
                redisMulti.exec()
            ]);

            // --- 8. Broadcast Updates & Confirmations ---
            socket.emit("cardConfirmed", {
                cardIds: newCardIdSet.size > 0 ? Array.from(newCardIdSet).map(Number) : [],
                requestId
            });

            for (const cardId of cardsToRelease) {
                socket.to(strGameId).emit("cardReleased", { telegramId: strTelegramId, cardId: cardId });
            }
            for (const cardId of cardsToAdd) {
                socket.to(strGameId).emit("otherCardSelected", { telegramId: strTelegramId, cardId: cardId });
            }

            const [updatedSelections, numberOfPlayers] = await Promise.all([
                redis.hGetAll(gameCardsKey),
                redis.sCard(`gameSessions:${strGameId}`)
            ]);
            io.to(strGameId).emit("currentCardSelections", updatedSelections);
            io.to(strGameId).emit("gameid", { gameId: strGameId, numberOfPlayers });

        } catch (err) {
            console.error(`❌ cardSelected error for game ${strGameId}, user ${strTelegramId}:`, err);
            
            // --- FIX ---: Correctly fetch the user's *actual* current cards on error
            const allCards = await redis.hGetAll(gameCardsKey);
            const oldCardIds = [];
            for (const [cardId, ownerId] of Object.entries(allCards)) {
                 if (ownerId === strTelegramId) {
                    oldCardIds.push(Number(cardId));
                 }
            }
                                
            socket.emit("cardError", { 
                message: err.message || "An unexpected error occurred. Please try again.", 
                requestId,
                currentHeldCardIds: oldCardIds 
            });
        } finally {
            // --- 9. Release All Locks ---
            await redis.del(userActionLockKey);
            
            // --- FIX ---: Check if cardLockKeys has keys before looping
            if (cardLockKeys.length > 0) {
                for (const key of cardLockKeys) {
                    await redis.del(key); 
                }
            }
        }
    });


    socket.on("cardDeselected", async ({ telegramId, cardId, gameId }) => {
                const strTelegramId = String(telegramId);
                const strCardId = String(cardId);
                const gameCardsKey = `gameCards:${gameId}`;

                // Verify they own the card
                const owner = await redis.hGet(gameCardsKey, strCardId);
                if (owner !== strTelegramId) {
                    return; // Not their card
                }

                // Release the card
                await redis.hDel(gameCardsKey, strCardId);
                await GameCard.updateOne(
                    { gameId, cardId: Number(strCardId) },
                    { $set: { isTaken: false, takenBy: null } }
                );

                // Tell everyone else it's free
                socket.to(gameId).emit("cardReleased", { 
                    cardId: strCardId, 
                    telegramId: strTelegramId 
                });
            });



    socket.on("unselectCardOnLeave", async ({ gameId, telegramId }) => {
            console.log("unselectCardOnLeave is called for", telegramId);

            try {
                const strGameId = String(gameId);
                // ✅ CRITICAL FIX 1: Trim the ID (Just like playerLeave)
                const strTelegramId = String(telegramId).trim(); 
                const gameCardsKey = `gameCards:${strGameId}`;

                // --- 1. Find ALL cards owned by this user ---
                const allGameCards = await redis.hGetAll(gameCardsKey);
                
                // ✅ CRITICAL FIX 2: Use robust filtering with trim()
                // This catches the cards that strict equality (===) misses
                let cardsToRelease = Object.entries(allGameCards)
                    .filter(([_, ownerId]) => String(ownerId).trim() == strTelegramId)
                    .map(([cardId]) => cardId);

                // --- 2. Release Cards (If any exist) ---
                if (cardsToRelease.length > 0) {
                    console.log(`🍔 releasing ${cardsToRelease.length} cards for ${strTelegramId}`);

                    // A) Remove from Redis Hash
                    await redis.hDel(gameCardsKey, ...cardsToRelease);

                    // B) Update MongoDB
                    await GameCard.updateMany(
                        { gameId: strGameId, cardId: { $in: cardsToRelease.map(Number) } },
                        { $set: { isTaken: false, takenBy: null } }
                    );

                    // ✅ CRITICAL FIX 3: Double-Check (The "Leftover" Check)
                    // Sometimes high-concurrency causes the first delete to miss a key. 
                    // We check again immediately.
                    const verifyGameCards = await redis.hGetAll(gameCardsKey);
                    const leftovers = Object.entries(verifyGameCards)
                        .filter(([_, ownerId]) => String(ownerId).trim() == strTelegramId)
                        .map(([cardId]) => cardId);

                    if (leftovers.length > 0) {
                        console.log(`⚠️ Found leftover cards after release, deleting again: ${leftovers.join(', ')}`);
                        await redis.hDel(gameCardsKey, ...leftovers);
                        cardsToRelease.push(...leftovers);
                    }

                    // C) Notify Frontend
                    io.to(strGameId).emit("cardsReleased", { 
                        cardIds: cardsToRelease, 
                        telegramId: strTelegramId 
                    });
                    
                    console.log(`🧹🔥🔥🔥🔥 Released cards from Redis: ${cardsToRelease.join(', ')}`);
                } else {
                    console.log(`ℹ️ No cards found in Redis for ${strTelegramId} to release.`);
                }

                // --- 3. Clean up Session Keys & SETS ---
                // Removing from SETS is required to fix the "Player Count"
                await Promise.all([
                    redis.hDel("userSelections", socket.id),
                    redis.hDel("userSelections", strTelegramId),
                    redis.hDel("userSelectionsByTelegramId", strTelegramId),
                    redis.del(`activeSocket:${strTelegramId}:${socket.id}`),
                    
                    // ✅ CRITICAL FIX 4: Remove from gameRooms/gameSessions (Just like playerLeave)
                    redis.sRem(`gameSessions:${strGameId}`, strTelegramId), 
                    redis.sRem(`gameRooms:${strGameId}`, strTelegramId) 
                ]);
                
                // Emit updated player count so the frontend updates immediately
                const playerCount = await redis.sCard(`gameRooms:${strGameId}`);
                io.to(strGameId).emit("playerCountUpdate", { gameId: strGameId, playerCount });

            } catch (err) {
                console.error("unselectCardOnLeave error:", err);
            }
        });



    // --- UPDATED: socket.on("joinGame") ---
    socket.on("joinGame", async ({ gameId, GameSessionId, telegramId, userHeldCardId }) => {
        console.log("joinGame is invoked 🔥🔥🔥");
        try {
            const strGameId = String(gameId);
            const strGameSessionId = String(GameSessionId);
            const strTelegramId = String(telegramId);
            const numTelegramId = Number(telegramId);
            const timeoutKey = `${strTelegramId}:${strGameId}:joinGame`;

            // 1. CRITICAL: Check for and cancel any pending cleanup for this user.
            if (pendingDisconnectTimeouts.has(timeoutKey)) {
                clearTimeout(pendingDisconnectTimeouts.get(timeoutKey));
                pendingDisconnectTimeouts.delete(timeoutKey);
                console.log(`🕒 Player ${strTelegramId} reconnected within the grace period. Cancelling cleanup.`);
            }

            // 2. ROBUST MEMBERSHIP CHECK 
            const playerSessionRecord = await PlayerSession.findOne({ 
                GameSessionId: strGameSessionId, 
                telegramId: strTelegramId
            });
            
            if (!playerSessionRecord) {
                console.warn(`🚫 Blocked user ${strTelegramId}: Player record not found in PlayerSession.`);
                socket.emit("joinError", { message: "You are not registered in this game session." });
                return;
            }

            // 3. GAME STATUS CHECK
            const currentGameControl = await GameControl.findOne({ GameSessionId: strGameSessionId });
            
            if (currentGameControl?.endedAt) {
                console.log(`🔄 Player ${strTelegramId} tried to join a game that has ended.`);
                const winnerRaw = await redis.get(`winnerInfo:${strGameSessionId}`);
                if (winnerRaw) {
                    const winnerInfo = JSON.parse(winnerRaw);
                    socket.emit("winnerConfirmed", winnerInfo);
                    console.log(`✅ Redirecting player ${strTelegramId} to winner page.`);
                } else {
                    socket.emit("gameEnd", { message: "The game has ended." });
                    console.log(`✅ Redirecting player ${strTelegramId} to home page.`);
                }
            }

            // 4. UPDATE CONNECTION STATUS (Reconnection successful)
            const updatedSession = await PlayerSession.findOneAndUpdate(
                { _id: playerSessionRecord._id, status: 'disconnected' },
                { $set: { status: 'connected' } },
                { new: true }
            );
            
            if (updatedSession) {
                console.log(`👤 Player ${strTelegramId} reconnected. Status updated to 'connected'.`);
            } else {
                console.log(`👤 Player ${strTelegramId} was already 'connected' or status was unexpected. Proceeding.`);
            }


            // ----------------------------------------------------
            // ✅ AGGRESSIVE CLEANUP AND CORRECT TTL REGISTRATION
            // ----------------------------------------------------
            
            // 4.5. AGGRESSIVE CLEANUP: Find ALL old activeSocket keys for this user
            const activeSocketKeyPattern = `activeSocket:${strTelegramId}:*`;
            const allKeysForUser = await redis.keys(activeSocketKeyPattern);
            
            const keysToDelete = allKeysForUser.filter(key => !key.endsWith(`:${socket.id}`));
            
            if (keysToDelete.length > 0) {
                await redis.del(...keysToDelete); 
                console.log(`🧹 AGGRESSIVELY deleted ${keysToDelete.length} stale activeSocket keys for ${strTelegramId}.`);
            }
            
            // 4.6. CORRECT TTL REGISTRATION: Set the new key with a 2-hour TTL
            const activeSocketKey = `activeSocket:${strTelegramId}:${socket.id}`;
            await redis.set(activeSocketKey, '1', 'EX', 7200); // 7200 seconds = 2 hours
            console.log(`Backend: Socket ${socket.id} for ${strTelegramId} set up with 2hr TTL.`);
            
            // ----------------------------------------------------


            // --- 5. REDIS & SOCKET.IO SETUP (Standard Flow) ---

            // Add to Redis hash for socket tracking (Crucial for disconnect mapping)
            const joinGameSocketInfo = await redis.hSet(`joinGameSocketsInfo`, socket.id, JSON.stringify({
                telegramId: strTelegramId,
                gameId: strGameId,
                GameSessionId: strGameSessionId,
                phase: 'joinGame'
            }));
            
            // ❌ REMOVED: THE REDUNDANT AND INCORRECT TTL LINE WAS HERE.
            
            // Add user back to the Socket.IO room and Redis room set
            await redis.sAdd(`gameRooms:${strGameId}`, strTelegramId);
            socket.join(strGameId);
            const playerCount = await redis.sCard(`gameRooms:${strGameId}`);
            io.to(strGameId).emit("playerCountUpdate", { gameId: strGameId, playerCount });
            console.log(`[joinGame] Player ${strTelegramId} rejoined game ${strGameId}, total players now: ${playerCount}`);

            // Emit initial session details
            socket.emit("gameId", {
                gameId: strGameId,
                GameSessionId: strGameSessionId,
                telegramId: strTelegramId
            });

            // Send historical drawn numbers if game is active
            const gameDrawsKey = getGameDrawsKey(strGameSessionId);
            const drawnNumbersRaw = await redis.lRange(gameDrawsKey, 0, -1);
            if (drawnNumbersRaw.length > 0) {
                const drawnNumbers = drawnNumbersRaw.map(Number);
                const formattedDrawnNumbers = drawnNumbers.map(number => {
                    const letterIndex = Math.floor((number - 1) / 15);
                    const letter = ["B", "I", "N", "G", "O"][letterIndex];
                    return { number, label: `${letter}-${number}` };
                });
                socket.emit("drawnNumbersHistory", {
                    gameId: strGameId,
                    GameSessionId: strGameSessionId,
                    history: formattedDrawnNumbers
                });
                console.log(`[joinGame] Sent historical drawn numbers to ${strTelegramId}.`);
            }
            
        } catch (err) {
            console.error("❌ Database or Redis error in joinGame:", err);
            socket.emit("joinError", { message: "Failed to join game. Please refresh or retry." });
        }
    });

 
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

    const HOUSE_CUT_PERCENTAGE = 0.20;
    const MIN_PLAYERS_TO_START = 2; // Your minimum player counts

    socket.on("gameCount", async ({ gameId, GameSessionId }) => {
        const strGameId = String(gameId);
        const strGameSessionId = String(GameSessionId);

        console.log("gameCount gamesessionId", GameSessionId);

        try {
            // --- 0. PREVENT DOUBLE COUNTDOWN ---
            if (state.countdownIntervals[strGameId]) {
                console.log(`⏳ Countdown for game ${strGameId} is already running. Ignoring new 'gameCount' trigger.`);
                return;
            }

                if (await isGameLockedOrActive(strGameId, redis, state)) {
                console.log(`⚠️ Game ${strGameId} is already active or locked. Ignoring gameCount event.`);
                return;
            }

            const lockAcquired = await acquireGameLock(strGameId, redis, state);

            if (!lockAcquired) {
                console.log(`⚠️ Failed to acquire lock for game ${strGameId}. Another process beat us to it.`);
                return; // 🛑 CRITICAL: Exit if the atomic lock failed
            }

            console.log(`🚀 Acquired lock for game ${strGameId}.`);

            // Optional Redis Countdown Lock (safety across multiple nodes)
            const countdownLockKey = `countdown:${strGameId}`;
            const countdownLock = await redis.set(countdownLockKey, "1", { NX: true, EX: 35 });
            if (!countdownLock) {
                console.log(`⏳ Countdown already running in Redis for game ${strGameId}. Exiting.`);
                return;
            }

            // --- 1. VALIDATE PLAYER COUNT ---
            const connectedPlayersCount = await PlayerSession.countDocuments({
                GameSessionId: strGameSessionId,
                status: 'connected'
            });

            if (connectedPlayersCount < MIN_PLAYERS_TO_START) {
                console.log(`🛑 Not enough players to start game ${strGameId}. Found: ${connectedPlayersCount}`);
                io.to(strGameId).emit("gameNotStarted", { message: "Not enough connected players to start the game." });
                await fullGameCleanup(strGameId, redis, state);
                await redis.del(countdownLockKey);
                return;
            }


            await prepareNewGame(strGameId, strGameSessionId, redis, state);

            // --- 2. START COUNTDOWN ---
            let countdownValue = 30;
            io.to(strGameId).emit("countdownTick", { countdown: countdownValue });
            await redis.set(getCountdownKey(strGameId), countdownValue.toString());

            state.countdownIntervals[strGameId] = setInterval(async () => {
                if (countdownValue > 0) {
                    countdownValue--;
                    io.to(strGameId).emit("countdownTick", { countdown: countdownValue });
                    await redis.set(getCountdownKey(strGameId), countdownValue.toString());
                } else {
                    // --- 3. COUNTDOWN ENDED: ATOMIC LOCK ---
                    const gameStartingKey = `gameStarting:${strGameId}`;
                    const setNXResult = await redis.set(gameStartingKey, "1", {
                        NX: true, // Only set if key does NOT exist
                        EX: 20    // Safety TTL
                    });

                    // Stop and clean interval regardless of lock result
                    clearInterval(state.countdownIntervals[strGameId]);
                    delete state.countdownIntervals[strGameId];
                    await redis.del(getCountdownKey(strGameId));

                    // Check lock result
                    if (setNXResult !== 'OK') {
                        console.log(`Lobby ${strGameId}: Lost atomic lock. Another worker is starting the game.`);
                    // await redis.del(countdownLockKey);
                        return;
                    }

                    console.log(`Lobby ${strGameId}: Successfully acquired atomic lock. Starting the game process.`);

                    // --- 4. START GAME ---
                    await processDeductionsAndStartGame(strGameId, strGameSessionId, io, redis, state);

                    // Cleanup countdown lock after game start
                    await redis.del(countdownLockKey);
                }
            }, 1000);

        } catch (err) {
            console.error(`❌ Fatal error in gameCount for ${strGameId}:`, err);
            io.to(strGameId).emit("gameNotStarted", { message: "Error during game setup." });
            await fullGameCleanup(strGameId, redis, state);
        }
    });


// --- HELPER FUNCTIONS ---
   async function isGameLockedOrActive(gameId, redis, state) {
        const strGameId = String(gameId);

        // --- 1. Check In-Memory and Redis Locks (Fast Path) ---
        let [redisHasLock, redisIsActive] = await Promise.all([
            redis.get(getActiveDrawLockKey(strGameId)),
            redis.get(getGameActiveKey(strGameId))
        ]);

        if (state.activeDrawLocks[gameId] || redisHasLock === "true" || redisIsActive === "true") {
            return true; // Game is locked.
        }

        // --- 2. Check DB (Source of Truth) ---
        // At this point, no locks were found. Check the database as the final authority.
        const activeGame = await GameControl.findOne({ 
            gameId: strGameId, 
            isActive: true, 
            endedAt: null 
        }).select('_id').lean();

        if (activeGame) {
            // The game IS active in the DB, but Redis is out of sync.
            // Fix Redis for next time and return TRUE.
            console.warn(`[isGameLockedOrActive] Fixed out-of-sync 'gameActive' key for ${strGameId}`);
            await redis.set(getGameActiveKey(strGameId), "true", 'EX', 1800); 
            return true; // ✅ CRITICAL FIX: Return true immediately
        }
        
        // --- 3. Final Result ---
        // Game is not active in memory, Redis, or the DB.
        return false;
    }

// Helper to acquire the game lockS
    async function acquireGameLock(gameId, redis, state) {
        const lockKey = getActiveDrawLockKey(gameId);
        
        // Attempt to set the lock ONLY IF IT DOES NOT EXIST (NX)
        // and give it an expiration time (EX) of 300 seconds (5 minutes)
        const lockAcquired = await redis.set(lockKey, 'true', 'NX', 'EX', 300);

        if (lockAcquired) {
            // Only update in-memory state if Redis lock was successfully acquired
            state.activeDrawLocks[gameId] = true;
            return true; // Lock secured
        }
        
        // If lockAcquired is null, the lock already existed.
        return false; // Lock failed to secure
    }

    // Helper to prepare a new game (shuffle numbers, etc.)
    async function prepareNewGame(gameId, gameSessionId, redis, state) {
        // Generate numbers 1–75
        const numbers = Array.from({ length: 75 }, (_, i) => i + 1);

        // ✅ Proper uniform shuffle (Fisher–Yates)
        for (let i = numbers.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [numbers[i], numbers[j]] = [numbers[j], numbers[i]]; // swap
        }
        await redis.set(getGameDrawStateKey(gameSessionId), JSON.stringify({ numbers, index: 0 }));
        // Any other initial setup (e.g., clearing previous session data)
        await Promise.all([
            redis.del(getGameActiveKey(gameId)),
            redis.del(getGameDrawsKey(gameSessionId)),
        ]);
    }

    // The core logic for player deductions and game start
    async function processDeductionsAndStartGame(strGameId, strGameSessionId, io, redis, state) {
        const session = await mongoose.startSession();
        
        // 1. Pre-Check (Fetch Meta and Players)
        const gameControlMeta = await GameControl.findOne({ GameSessionId: strGameSessionId }).select('stakeAmount -_id');
        const stakeAmount = gameControlMeta?.stakeAmount || 0;

        const connectedPlayerSessions = await PlayerSession.find({ 
            GameSessionId: strGameSessionId, 
            status: 'connected' 
        }).select('telegramId cardIds').lean();

        if (connectedPlayerSessions.length < MIN_PLAYERS_TO_START) {
            console.log("🛑 Not enough connected players.");
            io.to(strGameId).emit("gameNotStarted", { message: "Not enough players to start." });
            await fullGameCleanup(strGameId, redis, state);
            await session.endSession();
            return;
        }

        // --- Optimization: Fetch all Users in ONE query ---
        const allTelegramIds = connectedPlayerSessions.map(p => Number(p.telegramId));
        const users = await User.find({ telegramId: { $in: allTelegramIds } }).session(session);

    

        let successfullyDeductedPlayers = [];
        let finalPlayerObjects = [];
        let totalPot = 0;
        let finalTotalCards = 0;
        let prizeAmount = 0;
        let houseProfit = 0;
        let isHouseCutFree = false;

        // Containers for Bulk Operations
        const userBulkOps = [];
        const ledgerBulkOps = [];

        try {
            await session.withTransaction(async () => {
                
                // A. PREPARE CALCULATIONS & BULK OPERATIONS
            // A. PREPARE CALCULATIONS & BULK OPERATIONS
                        for (const playerSession of connectedPlayerSessions) {
                            const playerTelegramId = Number(playerSession.telegramId);
                            const numCards = (playerSession.cardIds || []).length;
                            
                            // 1. Check Cards First
                            if (numCards === 0) {
                                console.log(`⚠️ Skipping ${playerTelegramId}: Zero cards found in PlayerSession.`);
                                continue; 
                            }

                            // 2. FIND the user from the pre-fetched array FIRST
                            const user = users.find(u => u.telegramId === playerTelegramId);

                            // 3. Safety Check: If user doesn't exist, skip logs and logic
                            if (!user) {
                                console.log(`⚠️ Skipping ${playerTelegramId}: User document not found in DB.`);
                                continue;
                            }

                            // 4. NOW it is safe to define these variables
                            const currentBonus = user.bonus_balance || 0;
                            const currentMain = user.balance || 0;
                            const totalAvailable = currentBonus + currentMain;
                            const stakeToDeduct = stakeAmount * numCards;

                            // 5. Run Debug Logs (Now that variables are initialized)
                            if (user.reservedForGameId !== strGameId) {
                                console.log(`⚠️ Skipping ${playerTelegramId}: Reservation mismatch. DB has '${user.reservedForGameId}', expected '${strGameId}'`);
                            }
                            if (totalAvailable < stakeToDeduct) {
                                console.log(`⚠️ Skipping ${playerTelegramId}: Low balance. Has ${totalAvailable}, needs ${stakeToDeduct}`);
                            }
                            
                            // 6. Final Validation & Bulk Op Preparation
                            if (user.reservedForGameId === strGameId && totalAvailable >= stakeToDeduct) {
                                let remainingCost = stakeToDeduct;
                                let deductedFromBonus = 0;
                                let deductedFromMain = 0;

                                if (currentBonus > 0) {
                                    deductedFromBonus = Math.min(currentBonus, remainingCost);
                                    remainingCost -= deductedFromBonus;
                                }
                                if (remainingCost > 0) {
                                    deductedFromMain = remainingCost;
                                }

                                userBulkOps.push({
                                    updateOne: {
                                        filter: { telegramId: playerTelegramId },
                                        update: { 
                                            $inc: { balance: -deductedFromMain, bonus_balance: -deductedFromBonus },
                                            $unset: { reservedForGameId: "" }
                                        }
                                    }
                                });

                                const transType = (deductedFromMain > 0) ? 'stake_deduction' : 'bonus_stake_deduction';
                                ledgerBulkOps.push({
                                    insertOne: {
                                        document: {
                                            gameSessionId: strGameSessionId,
                                            amount: -stakeToDeduct,
                                            transactionType: transType,
                                            telegramId: String(playerTelegramId),
                                            description: `Stake for ${numCards} cards (Bonus: ${deductedFromBonus}, Main: ${deductedFromMain})`
                                        }
                                    }
                                });

                                successfullyDeductedPlayers.push(playerTelegramId);
                                finalPlayerObjects.push({ telegramId: playerTelegramId, status: 'connected' });
                                totalPot += stakeToDeduct;
                                finalTotalCards += numCards;
                            } else {
                                userBulkOps.push({
                                    updateOne: {
                                        filter: { telegramId: playerTelegramId },
                                        update: { $unset: { reservedForGameId: "" } }
                                    }
                                });
                            }
                        }

                // B. EXECUTE ALL DATABASE WRITES IN 2 CALLS (Instead of 200+)
                if (successfullyDeductedPlayers.length < MIN_PLAYERS_TO_START) {
                    throw new Error("MIN_PLAYERS_NOT_MET_AFTER_DEDUCTION");
                }

                if (userBulkOps.length > 0) {
                    await User.bulkWrite(userBulkOps, { session });
                }
                if (ledgerBulkOps.length > 0) {
                    await Ledger.bulkWrite(ledgerBulkOps, { session });
                }

                // C. HOUSE CUT & STATS (Stays sequential as it's 1-2 ops)
                const today = new Date();
                today.setHours(0, 0, 0, 0);
                const stats = await GlobalGameStats.findOneAndUpdate(
                    { date: today },
                    { $inc: { gamesPlayed: 1 } },
                    { new: true, upsert: true, session }
                ).select('gamesPlayed');

                if (stats.gamesPlayed % 7 === 0) {
                    prizeAmount = totalPot;
                    isHouseCutFree = true;
                } else {
                    houseProfit = totalPot * HOUSE_CUT_PERCENTAGE;
                    prizeAmount = totalPot - houseProfit;
                }

                // D. ACTIVATE GAME & UPDATE CARDS
                await GameControl.findOneAndUpdate(
                    { GameSessionId: strGameSessionId, isActive: false },
                    { $set: { isActive: true, totalCards: finalTotalCards, prizeAmount, houseProfit, isHouseCutFree, players: finalPlayerObjects } },
                    { session }
                );

                await GameCard.updateMany(
                    { gameId: strGameId, isTaken: true, takenBy: { $in: successfullyDeductedPlayers } }, 
                    { $set: { GameSessionId: strGameSessionId } },
                    { session }
                );

                await redis.del(`gameCards:${strGameId}`);
                io.to(strGameId).emit("gameCardResetOngameStart");
            });

            // 3. POST-COMMIT TASKS
            await syncGameIsActive(strGameId, true, redis);
            
            // Parallel Redis Balance Sync
            await Promise.all(successfullyDeductedPlayers.map(async (id) => {
                const u = await User.findOne({ telegramId: id }).select('balance bonus_balance').lean();
                if (u) {
                    await redis.set(`userBalance:${id}`, u.balance.toString(), "EX", 60);
                    await redis.set(`userBonusBalance:${id}`, u.bonus_balance.toString(), "EX", 60);
                }
            }));

            delete state.activeDrawLocks[strGameId];
            io.to(strGameId).emit("gameDetails", {
                winAmount: prizeAmount,
                playersCount: successfullyDeductedPlayers.length,
                cardCount: finalTotalCards,
                stakeAmount,
                totalDrawingLength: 75,
                isHouseCutFree
            });
            io.to(strGameId).emit("gameStart", { gameId: strGameId });
            await startDrawing(strGameId, strGameSessionId, io, state, redis);

        } catch (error) {
            console.error("❌ Transaction Aborted:", error.message);
            io.to(strGameId).emit("gameNotStarted", { message: "Game aborted. Funds safe." });
            await fullGameCleanup(strGameId, redis, state);
        } finally {
            await redis.del(`gameStarting:${strGameId}`);
            await session.endSession();
        }
    }



  // Helper to refund all players who were successfully deducted
    async function refundStakes(playerIds, strGameSessionId, stakeAmount, redis) { // stakeAmount is now just a fallback
        for (const playerId of playerIds) {
            try {
                // 1. Find the original deduction record from the ledger
                const deductionRecord = await Ledger.findOne({
                    telegramId: String(playerId),
                    gameSessionId: strGameSessionId,
                    transactionType: { $in: ['stake_deduction', 'bonus_stake_deduction'] }
                });

                let updateQuery;
                let refundTransactionType;
                let wasBonus = false;
                // --- NEW ---: This is the amount we will refund
                let amountToRefund = stakeAmount; // Default fallback

                if (deductionRecord) {
                    // --- FIX ---: Use the actual amount from the ledger
                    amountToRefund = Math.abs(deductionRecord.amount); 
                }

                // 2. Determine which balance to refund based on the record
                if (deductionRecord && deductionRecord.transactionType === 'bonus_stake_deduction') {
                    // Player paid with BONUS, so refund to BONUS balance
                    // --- FIX ---: Use amountToRefund
                    updateQuery = { $inc: { bonus_balance: amountToRefund }, $unset: { reservedForGameId: "" } };
                    refundTransactionType = 'bonus_stake_refund';
                    wasBonus = true;
                    console.log(`Player ${playerId} paid with bonus. Preparing bonus refund.`);
                } else {
                    // Player paid with MAIN, or we couldn't find a record (safe fallback)
                    // --- FIX ---: Use amountToRefund
                    updateQuery = { $inc: { balance: amountToRefund }, $unset: { reservedForGameId: "" } };
                    refundTransactionType = 'stake_refund';
                    if (!deductionRecord) {
                        console.warn(`⚠️ Ledger record not found for player ${playerId}. Defaulting to main balance refund of ${amountToRefund}.`);
                    }
                }

                // 3. Update the user's document with the correct balance refund
                const refundedUser = await User.findOneAndUpdate({ telegramId: playerId }, updateQuery, { new: true });

                if (refundedUser) {
                    // 4. Update the correct balance in Redis cache
                    if (wasBonus) {
                        await redis.set(`userBonusBalance:${playerId}`, refundedUser.bonus_balance.toString(), "EX", 60);
                    } else {
                        await redis.set(`userBalance:${playerId}`, refundedUser.balance.toString(), "EX", 60);
                    }

                    // 5. Create a new ledger entry for the refund transaction
                    await Ledger.create({
                        gameSessionId: strGameSessionId,
                        amount: amountToRefund, // --- FIX ---
                        transactionType: refundTransactionType,
                        telegramId: String(playerId),
                        description: `Stake refund for cancelled game session ${strGameSessionId}`
                    });
                    console.log(`✅ Successfully refunded ${amountToRefund} to ${wasBonus ? 'bonus' : 'main'} balance for player ${playerId}.`);
                } else {
                    console.error(`❌ Could not find user ${playerId} to process refund.`);
                }

            } catch (error) {
                console.error(`❌ Error processing refund for player ${playerId}:`, error);
            }
        }
    }

    // Helper to perform a full cleanup of game state
 



    async function startDrawing(gameId, GameSessionId, io, state, redis, socket) { // Ensuring socket is present for resetRound
        const strGameId = String(gameId);
        const strGameSessionId = String(GameSessionId);
        const gameDrawStateKey = getGameDrawStateKey(strGameSessionId);
        const gameDrawsKey = getGameDrawsKey(strGameSessionId);
        const gameRoomsKey = getGameRoomsKey(strGameId);

        // Define the required variable delays
        const DRAW_INITIAL_DELAY = 2000; // 2 seconds for the first number
        const DRAW_SUBSEQUENT_DELAY = 4000; // 4 seconds for all numbers after the first

        if (state.drawIntervals[strGameId]) {
            console.log(`⛔️ Drawing already in progress for game ${strGameId}, skipping.`);
            return;
        }

        console.log(`🎯 Starting the drawing process for gameId: ${strGameId}. First draw in ${DRAW_INITIAL_DELAY/1000}s, then every ${DRAW_SUBSEQUENT_DELAY/1000}s.`);
        await redis.del(gameDrawsKey);

        const drawNextNumber = async () => {
            try {
                const currentPlayersInRoom = (await redis.sCard(gameRoomsKey)) || 0;

                // --- STOP CONDITION: NO PLAYERS ---
                if (currentPlayersInRoom === 0) {
                    console.log(`🛑 No players left. Stopping drawing and initiating round reset.`);
                    // Clean up the recurring timer
                    clearInterval(state.drawIntervals[strGameId]);
                    delete state.drawIntervals[strGameId];
                    await resetRound(strGameId, GameSessionId, socket, io, state, redis);
                    io.to(strGameId).emit("gameEnded", { message: "Game ended due to all players leaving the room." });
                    return;
                }

                // Read game state from Redis
                const gameDataRaw = await redis.get(gameDrawStateKey);
                if (!gameDataRaw) {
                    console.log(`❌ No game draw data found for ${strGameId}. Stopping draw.`);
                    clearInterval(state.drawIntervals[strGameId]);
                    delete state.drawIntervals[strGameId];
                    return;
                }

                const gameData = JSON.parse(gameDataRaw);

                // --- STOP CONDITION: ALL NUMBERS DRAWN ---
                if (gameData.index >= gameData.numbers.length) {
                    console.log(`🎯 All numbers drawn for game ${strGameId}`);
                    clearInterval(state.drawIntervals[strGameId]);
                    delete state.drawIntervals[strGameId];
                    io.to(strGameId).emit("allNumbersDrawn", { gameId: strGameId });
                    await resetRound(strGameId, GameSessionId, socket, io, state, redis);
                    return;
                }

                // --- DRAW PROCESS ---
                const number = gameData.numbers[gameData.index];
                gameData.index += 1;

                const callNumberLength = await redis.rPush(gameDrawsKey, number.toString());
                gameData.callNumberLength = callNumberLength;
                await redis.set(gameDrawStateKey, JSON.stringify(gameData));

                // Format and emit
                const letter = ["B", "I", "N", "G", "O"][Math.floor((number - 1) / 15)];
                const label = `${letter}-${number}`;
                io.to(strGameId).emit("numberDrawn", { number, label, gameId: strGameId, callNumberLength });
                console.log(`🔢 Drew number: ${label}, Total drawn: ${callNumberLength}`);

            } catch (error) {
                console.error(`❌ Error drawing number for game ${strGameId}:`, error);
                clearInterval(state.drawIntervals[strGameId]);
                delete state.drawIntervals[strGameId];
                await resetRound(strGameId, GameSessionId, socket, io, state, redis);
                io.to(strGameId).emit("gameEnded", { gameId: strGameId, message: "Game ended due to drawing error." });
            }
        };

        // 🕑 Draw the first number after the initial delay (2 seconds)
        setTimeout(async () => {
            await drawNextNumber(); // Draw the first number

            // 🕓 Then start the recurring interval (4 seconds)
            // Store the ID of the setInterval so it can be cleared by drawNextNumber or other handlers
            state.drawIntervals[strGameId] = setInterval(async () => {
                await drawNextNumber();
            }, DRAW_SUBSEQUENT_DELAY);

        }, DRAW_INITIAL_DELAY);
    }



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

            // --- 4️⃣ Atomic Financial Commit & State Transition (CRITICAL) ---
            try {
                (async () => {
                    try {
                        const historyJob = {
                            type: 'PROCESS_GAME_HISTORY',
                            strGameSessionId,
                            strGameId,
                            winnerId: String(telegramId), // Keep as string for consistency
                            prizeAmount,
                            stakeAmount,
                            callNumberLength,
                            firedAt: new Date()
                        };

                    // LPUSH is atomic and takes microseconds
                    await redis.lPush('game-task-queue', JSON.stringify(historyJob));
                    
                    console.log(`🚀 Task queued for Session: ${strGameSessionId}`);
                } catch (err) {
                    console.error("❌ Failed to queue history job:", err);
                }
            })();

          // Pass the necessary IO and Redis clients for post-commit cleanup (not inside the transaction)
            await processWinnerAtomicCommit(winnerData, winnerUser, io, redis, state); 
            
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

            // --- Remove the player from the PlayerSession document ---
            // await PlayerSession.deleteOne({
            //     GameSessionId: GameSessionId,
            //     telegramId: strTelegramId,
            // });
            // console.log(`✅ PlayerSession record for ${telegramId} deleted.`);

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





         