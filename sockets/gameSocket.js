const User = require("../models/user");
const GameControl = require("../models/GameControl");
const GameHistory = require("../models/GameHistory")
const Ledger = require("../models/ledgerSchema");
const resetGame = require("../utils/resetGame");
const checkAndResetIfEmpty = require("../utils/checkandreset");
const redis = require("../utils/redisClient");
const  syncGameIsActive = require("../utils/syncGameIsActive");
const GameCard = require('../models/GameCard'); // Your Mongoose models
const checkBingoPattern = require("../utils/BingoPatterns")
const resetRound = require("../utils/resetRound");
const clearGameSessions = require('../utils/clearGameSessions'); // Adjust path as needed
const deleteCardsByTelegramId = require('../utils/deleteCardsByTelegramId');
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
const ACTIVE_DISCONNECT_GRACE_PERIOD_MS = 2 * 1000; // For card selection lobby (10 seconds)
const JOIN_GAME_GRACE_PERIOD_MS = 2 * 1000; // For initial join/live game phase (5 seconds)
const ACTIVE_SOCKET_TTL_SECONDS = 60 * 3;


module.exports = function registerGameSocket(io) {
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
  io.on("connection", (socket) => {
      console.log("🟢 New client connected");
      console.log("Client connected with socket ID:", socket.id);
      // User joins a game

   //socket.emit("connected")

// User joins a game
    // --- UPDATED: socket.on("userJoinedGame") ---
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
    const { telegramId, cardId, card, gameId, requestId } = data;

    // --- 1. Data Sanitization & Key Preparation ---
    const strTelegramId = String(telegramId);
    const strCardId = String(cardId);
    const strGameId = String(gameId);
    const cleanCard = card.map(row => row.map(c => (c === "FREE" ? 0 : Number(c))));

    const userActionLockKey = `lock:userAction:${strGameId}:${strTelegramId}`;
    const cardLockKey = `lock:card:${strGameId}:${strCardId}`;

    // Redis keys
    const gameCardsKey = `gameCards:${strGameId}`;
    const userSelectionsKey = `userSelections`;
    const userSelectionsByTelegramIdKey = `userSelectionsByTelegramId`;
    const userLastRequestIdKey = `userLastRequestId`;

    // --- 2. Acquire User-Level Lock ---
    const userLock = await redis.set(userActionLockKey, requestId, "NX", "EX", 10);
    if (!userLock) {
        return socket.emit("cardError", {
            message: "⏳ Your previous action is still processing. Please wait a moment.",
            requestId
        });
    }

    try {
        // --- 3. Get User's Current Selection from the authoritative source: gameCardsKey ---
        const existingOwnerId = await redis.hGet(gameCardsKey, strCardId);
        
        // --- 4. Get the user's *previous* selection to clean up ---
        let previousCardIdToRelease = null;
        const allGameCards = await redis.hGetAll(gameCardsKey);
        
        for (const [key, value] of Object.entries(allGameCards)) {
            if (value === strTelegramId) {
                previousCardIdToRelease = key;
                break;
            }
        }
        
        // Exit early if the user is selecting the same card they already have
        if (existingOwnerId === strTelegramId) {
            socket.emit("cardConfirmed", { cardId: strCardId, card: cleanCard, requestId });
            return;
        }

        // --- 5. Check Card Availability & Acquire Card-Level Lock ---
        // The card is taken by someone else
        if (existingOwnerId && existingOwnerId !== strTelegramId) {
              
    // A) Find the player's currently held card from Redis
            const previousCardIdToRelease = Object.keys(allGameCards).find(
                key => allGameCards[key] === strTelegramId
            );
        // B) If they had a card, release it from the DB and Redis
        if (previousCardIdToRelease) {
            // Asynchronously update the DB and Redis
            await Promise.all([
                GameCard.updateOne(
                    { gameId: strGameId, cardId: Number(previousCardIdToRelease), takenBy: strTelegramId },
                    { $set: { isTaken: false, takenBy: null } }
                ),
                redis.hDel(gameCardsKey, previousCardIdToRelease)
            ]);

            // Notify other clients about the released card
            socket.to(strGameId).emit("cardReleased", { 
                cardId: previousCardIdToRelease, 
                telegramId: strTelegramId 
            });
        }
            return socket.emit("cardUnavailable", { cardId: strCardId, requestId });
        }

        const cardLock = await redis.set(cardLockKey, strTelegramId, "NX", "EX", 10);
        if (!cardLock) {
            return socket.emit("cardUnavailable", { cardId: strCardId, requestId });
        }

        // --- 6. Perform the Atomic Swap: Release Old Card, Claim New Card ---

        // A) Release any previously held card(s) in the database.
        const dbUpdatePromises = [];
        dbUpdatePromises.push(
            GameCard.updateOne(
                { gameId: strGameId, cardId: { $ne: Number(strCardId) }, takenBy: strTelegramId },
                { $set: { isTaken: false, takenBy: null } }
            )
        );

        // B) Clean up Redis for the old card and notify clients.
        if (previousCardIdToRelease && previousCardIdToRelease !== strCardId) {
            dbUpdatePromises.push(
                redis.hDel(gameCardsKey, previousCardIdToRelease)
            );
            socket.to(strGameId).emit("cardReleased", { cardId: previousCardIdToRelease, telegramId: strTelegramId });
        }

        // C) Claim the new card in both DB and Redis
        const selectionData = JSON.stringify({
            telegramId: strTelegramId,
            cardId: strCardId,
            card: cleanCard,
            gameId: strGameId
        });

        dbUpdatePromises.push(
            GameCard.updateOne(
                { gameId: strGameId, cardId: Number(strCardId) },
                { $set: { card: cleanCard, isTaken: true, takenBy: strTelegramId } },
                { upsert: true }
            ),
            redis.hSet(gameCardsKey, strCardId, strTelegramId),
            redis.hSet(userSelectionsKey, socket.id, selectionData),
            redis.hSet(userSelectionsByTelegramIdKey, strTelegramId, selectionData),
            redis.hSet(userLastRequestIdKey, strTelegramId, requestId)
        );

        await Promise.all(dbUpdatePromises);

        // --- 7. Broadcast Updates & Confirmations ---
        socket.emit("cardConfirmed", { cardId: strCardId, card: cleanCard, requestId });
        socket.to(strGameId).emit("otherCardSelected", { telegramId: strTelegramId, cardId: strCardId });

        const [updatedSelections, numberOfPlayers] = await Promise.all([
            redis.hGetAll(gameCardsKey),
            redis.sCard(`gameSessions:${strGameId}`)
        ]);

        io.to(strGameId).emit("currentCardSelections", updatedSelections);
        io.to(strGameId).emit("gameid", { gameId: strGameId, numberOfPlayers });

    } catch (err) {
        console.error(`❌ cardSelected error for game ${strGameId}, user ${strTelegramId}:`, err);
        socket.emit("cardError", { message: "An unexpected error occurred. Please try again.", requestId });
    } finally {
        // --- 8. Release All Locks ---
        await redis.del(userActionLockKey);
        await redis.del(cardLockKey);
    }
});



      socket.on("unselectCardOnLeave", async ({ gameId, telegramId, cardId }) => {
        console.log("unselectCardOnLeave is called");
        console.log("unslected datas ", gameId, telegramId, cardId );

        try {
          const strCardId = String(cardId);
          const strTelegramId = String(telegramId);

          const currentCardOwner = await redis.hGet(`gameCards:${gameId}`, strCardId);
          console.log("🍔🍔🍔 cardowner", currentCardOwner);

          if (currentCardOwner === strTelegramId) {
            await redis.hDel(`gameCards:${gameId}`, strCardId);
            await GameCard.findOneAndUpdate(
              { gameId, cardId: Number(strCardId) },
              { isTaken: false, takenBy: null }
            );

           await Promise.all([
            redis.hDel("userSelections", socket.id),
            redis.hDel("userSelections", strTelegramId), // <-- This line
            redis.hDel("userSelectionsByTelegramId", strTelegramId), // ✅ Add this (already in disconnect)
            redis.del(`activeSocket:${strTelegramId}:${socket.id}`),
        ]);
            socket.to(gameId).emit("cardAvailable", { cardId: strCardId });

            console.log(`🧹🔥🔥🔥🔥 Card ${strCardId} released by ${strTelegramId}`);
          }
        } catch (err) {
          console.error("unselectCardOnLeave error:", err);
        }
      });



    // --- UPDATED: socket.on("joinGame") ---
    socket.on("joinGame", async ({ gameId, GameSessionId, telegramId }) => {
        console.log("joinGame is invoked 🔥🔥🔥");
        try {
            const strGameId = String(gameId);
            const strGameSessionId = String(GameSessionId);
            const strTelegramId = String(telegramId);
            const timeoutKey = `${strTelegramId}:${strGameId}:joinGame`;

            console.log("gameSessionID inside joingame", GameSessionId );

            // CRITICAL: Check for and cancel any pending cleanup for this user.
            if (pendingDisconnectTimeouts.has(timeoutKey)) {
                clearTimeout(pendingDisconnectTimeouts.get(timeoutKey));
                pendingDisconnectTimeouts.delete(timeoutKey);
                console.log(`🕒 Player ${strTelegramId} reconnected within the grace period. Cancelling cleanup.`);
            }

            // MODIFIED: Find the game and the specific player object within it.
            const game = await GameControl.findOne({ GameSessionId: strGameSessionId, 'players.telegramId': Number(strTelegramId) });

            // --- NEW LOGIC: Check if the player was in the game, but the game is now over. ---
            if (game?.endedAt) {
                console.log(`🔄 Player ${strTelegramId} tried to join a game that has ended.`);
                const winnerRaw = await redis.get(`winnerInfo:${strGameSessionId}`);
                if (winnerRaw) {
                    const winnerInfo = JSON.parse(winnerRaw);
                    // Redirect to winner page
                    socket.emit("winnerConfirmed", winnerInfo);
                    console.log(`✅ Redirecting player ${strTelegramId} to winner page.`);
                } else {
                    // Redirect to home page
                    socket.emit("gameEnd", { message: "The game has ended." });
                    console.log(`✅ Redirecting player ${strTelegramId} to home page.`);
                }
                return;
            }

            // If no record is found, the user was never in this game session.
            if (!game) {
                socket.emit("gameEnd", { message: "The game has ended." });
                console.warn(`🚫 Blocked user ${strTelegramId} from joining game session ${strGameSessionId} because no player record was found.`);
                const winnerRaw = await redis.get(`winnerInfo:${strGameSessionId}`);
                if (winnerRaw) {
                    const winnerInfo = JSON.parse(winnerRaw);
                    socket.emit("winnerConfirmed", winnerInfo);
                    return;
                }
                socket.emit("joinError", { message: "You are not registered in this game." });
                return;
            }

            // NEW: Update the player's status to 'connected' and save the document.
            await GameControl.findOneAndUpdate(
                { GameSessionId: strGameSessionId, 'players.telegramId': Number(strTelegramId) },
                { $set: { 'players.$.status': 'connected' } },
                { new: true } // Return the updated document
            );
            console.log(`👤 Player ${strTelegramId} status updated to 'connected' for game ${strGameId}.`);

            // The rest of the logic remains largely the same.
           const joinGameSocketInfo = await redis.hSet(`joinGameSocketsInfo`, socket.id, JSON.stringify({
                telegramId: strTelegramId,
                gameId: strGameId,
                GameSessionId: strGameSessionId,
                phase: 'joinGame'
            }));
            await redis.set(`activeSocket:${strTelegramId}:${socket.id}`, '1', 'EX', ACTIVE_SOCKET_TTL_SECONDS);
            console.log(`Backend: Socket ${socket.id} for ${strTelegramId} set up in 'joinGame' phase.`);
            console.log("joinsocket info🔥🔥", joinGameSocketInfo.GameSessionId);

            await redis.sAdd(`gameRooms:${strGameId}`, strTelegramId);
            console.log("➕➕➕players added to gameRooms", `gameRooms:${strGameId}`);
            socket.join(strGameId);

            const playerCount = await redis.sCard(`gameRooms:${strGameId}`);
            io.to(strGameId).emit("playerCountUpdate", {
                gameId: strGameId,
                playerCount,
            });
            console.log(`[joinGame] Player ${strTelegramId} joined game ${strGameId}, total players now: ${playerCount}`);

            socket.emit("gameId", {
                gameId: strGameId,
                GameSessionId: strGameSessionId,
                telegramId: strTelegramId
            });

            const gameDrawsKey = getGameDrawsKey(strGameSessionId);
            const drawnNumbersRaw = await redis.lRange(gameDrawsKey, 0, -1);
            const drawnNumbers = drawnNumbersRaw.map(Number);
            const formattedDrawnNumbers = drawnNumbers.map(number => {
                const letterIndex = Math.floor((number - 1) / 15);
                const letter = ["B", "I", "N", "G", "O"][letterIndex];
                return { number, label: `${letter}-${number}` };
            });

            if (formattedDrawnNumbers.length > 0) {
                socket.emit("drawnNumbersHistory", {
                    gameId: strGameId,
                    GameSessionId: strGameSessionId,
                    history: formattedDrawnNumbers
                });
                console.log(`[joinGame] Sent ${formattedDrawnNumbers.length} historical drawn numbers to ${strTelegramId} for session ${strGameSessionId}.`);
            }
        } catch (err) {
            console.error("❌ Redis error in joinGame:", err);
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
        // --- 1. PRE-VALIDATION & LOCK ACQUISITION ---
        if (await isGameLockedOrActive(strGameId, redis, state)) {
            console.log(`⚠️ Game ${strGameId} is already active or locked. Ignoring gameCount event.`);
            return;
        }

        await acquireGameLock(strGameId, redis, state);
        console.log(`🚀 Acquired lock for game ${strGameId}.`);

        const currentGameControl = await GameControl.findOne({ GameSessionId: strGameSessionId });
        if (!currentGameControl || currentGameControl.players.length < MIN_PLAYERS_TO_START) {
            console.log(`🛑 Not enough players to start game ${strGameId}. Found: ${currentGameControl?.players.length || 0}`);
            io.to(strGameId).emit("gameNotStarted", { message: "Not enough players to start the game." });
            await fullGameCleanup(strGameId, redis, state);
            return;
        }
        
        // --- 2. INITIAL GAME SETUP ---
        await prepareNewGame(strGameId, strGameSessionId, redis, state);
        
        // --- 3. START COUNTDOWN ---
        let countdownValue = 15;
        io.to(strGameId).emit("countdownTick", { countdown: countdownValue });
        await redis.set(getCountdownKey(strGameId), countdownValue.toString());

        state.countdownIntervals[strGameId] = setInterval(async () => {
            if (countdownValue > 0) {
                countdownValue--;
                io.to(strGameId).emit("countdownTick", { countdown: countdownValue });
                await redis.set(getCountdownKey(strGameId), countdownValue.toString());
            } else {
                clearInterval(state.countdownIntervals[strGameId]);
                delete state.countdownIntervals[strGameId];
                await redis.del(getCountdownKey(strGameId));

                await processDeductionsAndStartGame(strGameId, strGameSessionId, io, redis, state);
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
    const [redisHasLock, redisIsActive] = await Promise.all([
        redis.get(getActiveDrawLockKey(gameId)),
        redis.get(getGameActiveKey(gameId))
    ]);
    return state.activeDrawLocks[gameId] || redisHasLock === "true" || redisIsActive === "true";
}

// Helper to acquire the game lock
async function acquireGameLock(gameId, redis, state) {
    state.activeDrawLocks[gameId] = true;
    await redis.set(getActiveDrawLockKey(gameId), "true");
}

// Helper to prepare a new game (shuffle numbers, etc.)
async function prepareNewGame(gameId, gameSessionId, redis, state) {
    const numbers = Array.from({ length: 75 }, (_, i) => i + 1).sort(() => Math.random() - 0.5);
    await redis.set(getGameDrawStateKey(gameSessionId), JSON.stringify({ numbers, index: 0 }));
    // Any other initial setup (e.g., clearing previous session data)
    await Promise.all([
        redis.del(getGameActiveKey(gameId)),
        redis.del(getGameDrawsKey(gameSessionId)),
    ]);
}

// The core logic for player deductions and game start
async function processDeductionsAndStartGame(strGameId, strGameSessionId, io, redis, state) {
    // ⭐ Step 1: Query the database to get the most up-to-date player list
    const currentGameControl = await GameControl.findOne({GameSessionId: strGameSessionId }).select('players -_id');
    
    // ⭐ Step 2: Filter the player list to get only those with a 'connected' status
    const connectedPlayers = (currentGameControl?.players || []).filter(p => p.status === 'connected');
    
    const playersForDeduction = connectedPlayers.map(player => player?.telegramId).filter(Boolean);
    console.log("player connected are 🤑🤑", playersForDeduction);
    let successfulDeductions = 0;
    let finalPlayerList = [];
    // 🟢 Corrected: A new array to hold the full player objects for the GameControl update
    let finalPlayerObjects = [];
    let successfullyDeductedPlayers = [];
    const stakeAmount = Number(strGameId);
    
    if (playersForDeduction.length < MIN_PLAYERS_TO_START) {
        console.log(`🛑 Not enough players after countdown. Aborting.`);
        io.to(strGameId).emit("gameNotStarted", { message: "Not enough players to start." });
        await fullGameCleanup(strGameId, redis, state);
        return;
    }

    // --- Stake Deduction Loop ---
    for (const playerTelegramId of playersForDeduction) {
        try {
            const user = await User.findOneAndUpdate(
                { telegramId: playerTelegramId, reservedForGameId: strGameId, balance: { $gte: stakeAmount } },
                { $inc: { balance: -stakeAmount }, $unset: { reservedForGameId: "" } },
                { new: true }
            );
            if (user) {
                successfulDeductions++;
                // 🟢 Corrected: Push the telegramId for other logic (like redis)
                successfullyDeductedPlayers.push(playerTelegramId);
                // 🟢 Corrected: Push the full object into the new array for the GameControl update
                finalPlayerObjects.push({ telegramId: playerTelegramId, status: 'connected' });
                await redis.set(`userBalance:${playerTelegramId}`, user.balance.toString(), "EX", 60);

                 // ⭐ Log the stake deduction to the ledger
                await Ledger.create({
                    gameSessionId: strGameSessionId,
                    amount: -stakeAmount,
                    transactionType: 'stake_deduction',
                    telegramId: playerTelegramId,
                    description: `Stake deduction for game session ${strGameSessionId}`
                });

            } else {
                await User.updateOne({ telegramId: playerTelegramId }, { $unset: { reservedForGameId: "" } });
               await redis.sRem(getGameRoomsKey(strGameId), playerTelegramId.toString());
                await GameControl.updateOne({ GameSessionId: strGameSessionId }, { $pull: { players: { telegramId: playerTelegramId } } });
            }
        } catch (error) {
            console.error(`❌ Error deducting balance for player ${playerTelegramId}:`, error);
            await User.updateOne({ telegramId: playerTelegramId }, { $unset: { reservedForGameId: "" } });
        }
    }
    
    // --- Final Validation & Game Start/Refund ---
    if (successfulDeductions < MIN_PLAYERS_TO_START) {
        console.log("🛑 Not enough players after deductions. Refunding stakes.");
        await refundStakes(successfullyDeductedPlayers, strGameSessionId, stakeAmount, redis);
        io.to(strGameId).emit("gameNotStarted", { message: "Not enough players. Your stake has been refunded." });
        await fullGameCleanup(strGameId, redis, state);
        return;
    }

    // Game is a go!
   // ⭐ New logic to calculate the prize with the house cut
        const totalPot = stakeAmount * successfulDeductions;
        const houseProfit = totalPot * HOUSE_CUT_PERCENTAGE;
        const prizeAmount = totalPot - houseProfit; // This is the new, reduced prize amount

        // 🟢 Now, update the GameControl document with the correct prizeAmount and the new houseProfit field
        await GameControl.findOneAndUpdate(
        { GameSessionId: strGameSessionId },
        { $set: { 
            isActive: true, 
            totalCards: successfulDeductions, 
            prizeAmount: prizeAmount, 
            houseProfit: houseProfit, // ⭐ This line saves the profit to the database
            players: finalPlayerObjects 
        } }
        );
        await syncGameIsActive(strGameId, true);
    
    // Release the lock now that the game is officially active
    delete state.activeDrawLocks[strGameId];
    await redis.del(getActiveDrawLockKey(strGameId));

   // 🎯 NEW LOGIC: Release all selected cards before the game starts
   console.log(`🧹 Releasing all selected cards for game ${strGameId}...`);
   const gameCardsKey = `gameCards:${strGameId}`;

   try {
       // 1. Get all currently selected cards from Redis
       const allSelectedCards = await redis.hGetAll(gameCardsKey);

       // 2. Clear all card data in Redis and the DB
       await redis.del(gameCardsKey);
       await GameCard.updateMany(
            { gameId: strGameId, cardId: { $in: Object.keys(allSelectedCards).map(Number) } },
            { $set: { isTaken: false, takenBy: null } }
       );

       // ⭐ NEW: Emit a single event for the full reset instead of looping
       io.to(strGameId).emit("gameCardResetOngameStart");

   } catch (error) {
       console.error(`❌ Error releasing cards on game start for game ${strGameId}:`, error);
   }
   console.log(`✅ All cards released for game ${strGameId}.`);

      // --- EMIT GAME DETAILS BEFORE STARTING DRAWING ---
    const totalDrawingLength = 75; // Total numbers to be drawn
      
    console.log(`✅ Emitting gameDetails for game ${strGameId}:`, {
        winAmount: prizeAmount,
        playersCount: successfulDeductions,
        stakeAmount: stakeAmount,
        totalDrawingLength: 75,
     });

    io.to(strGameId).emit("gameDetails", { 
        winAmount: prizeAmount,
        playersCount: successfulDeductions,
        stakeAmount: stakeAmount,
        totalDrawingLength: totalDrawingLength,
    });

    console.log("⭐⭐ gameDetails emited");

    io.to(strGameId).emit("gameStart", { gameId: strGameId });
    await startDrawing(strGameId, strGameSessionId, io, state, redis);
}



// Helper to refund all players who were successfully deducted
async function refundStakes(playerIds,strGameSessionId, stakeAmount, redis) {
    for (const playerId of playerIds) {
        const refundedUser = await User.findOneAndUpdate({ telegramId: playerId }, { $inc: { balance: stakeAmount }, $unset: { reservedForGameId: "" } }, { new: true });
        if (refundedUser) {
            await redis.set(`userBalance:${playerId}`, refundedUser.balance.toString(), "EX", 60);
             await Ledger.create({
                gameSessionId: strGameSessionId,
                amount: stakeAmount, // The amount is positive for a refund
                transactionType: 'stake_refund',
                telegramId: playerId,
                description: `Stake refund for game session ${strGameSessionId}`
            });
        }
    }
}

// Helper to perform a full cleanup of game state
async function fullGameCleanup(gameId, redis, state) {
    delete state.activeDrawLocks[gameId];
    await redis.del(getActiveDrawLockKey(gameId));
    await syncGameIsActive(gameId, false);
    if (state.countdownIntervals[gameId]) { clearInterval(state.countdownIntervals[gameId]); delete state.countdownIntervals[gameId]; }
}




  async function startDrawing(gameId, GameSessionId, io, state, redis) { // Ensure state and redis are passed
    const strGameId = String(gameId);
    const strGameSessionId = String(GameSessionId); // Ensure gameId is always a string for Redis keys
    const gameDrawStateKey = getGameDrawStateKey(strGameSessionId);
    const gameDrawsKey = getGameDrawsKey(strGameSessionId);
    const gameRoomsKey = getGameRoomsKey(strGameId);
    const activeGameKey = getGameActiveKey(strGameId);

    if (state.drawIntervals[strGameId]) {
        console.log(`⛔️ Drawing already in progress for game ${strGameId}, skipping.`);
        return;
    }

    console.log(`🎯 Starting the drawing process for gameId: ${strGameId}`);

    // Clear any existing draws list at start (redundant if `gameCount` already cleared `gameDrawsKey`)
    await redis.del(gameDrawsKey);

    state.drawIntervals[strGameId] = setInterval(async () => {
        try {
            // Fetch current player count in the game room
            const currentPlayersInRoom = (await redis.sCard(gameRoomsKey)) || 0;

            if (currentPlayersInRoom === 0) {
                console.log(`🛑 No players left in game room ${strGameId}. Stopping drawing and initiating round reset.`);
                clearInterval(state.drawIntervals[strGameId]);
                delete state.drawIntervals[strGameId];

                await resetRound(strGameId, GameSessionId, socket, io, state, redis); // This call now handles all necessary cleanup.

                io.to(strGameId).emit("gameEnded", { gameId: strGameId, message: "Game ended due to all players leaving the room." });
                return;
            }

            // Read game state from Redis
            const gameDataRaw = await redis.get(gameDrawStateKey);
            if (!gameDataRaw) {
                console.log(`❌ No game draw data found for ${strGameId}, stopping draw.`);
                clearInterval(state.drawIntervals[strGameId]);
                delete state.drawIntervals[strGameId];
                return;
            }
            const gameData = JSON.parse(gameDataRaw);

            // Check if all numbers drawn
            if (gameData.index >= gameData.numbers.length) {
                clearInterval(state.drawIntervals[strGameId]);
                delete state.drawIntervals[strGameId];
                io.to(strGameId).emit("allNumbersDrawn", { gameId: strGameId });
                console.log(`🎯 All numbers drawn for game ${strGameId}`);

                await resetRound(strGameId, GameSessionId, socket, io, state, redis); // This call now handles all necessary cleanup.

                io.to(strGameId).emit("gameEnded", { gameId: strGameId, message: "All numbers drawn, game ended." });
                return;
            }

            // Draw the next number
            const number = gameData.numbers[gameData.index];
            gameData.index += 1;

            // Save updated game state back to Redis
            // Add the drawn number to the Redis list
            const callNumberLength = await redis.rPush(gameDrawsKey, number.toString());

            // ⭐ CORRECT ORDER: Update the gameData object in memory
            gameData.callNumberLength = callNumberLength; 

            // ⭐ CORRECT ORDER: Save the UPDATED game state back to Redis
            await redis.set(gameDrawStateKey, JSON.stringify(gameData));


            // Format the number label (e.g. "B-12")
            const letterIndex = Math.floor((number - 1) / 15);
            const letter = ["B", "I", "N", "G", "O"][letterIndex];
            const label = `${letter}-${number}`;

            console.log(`🔢 Drawing number: ${label}, Index: ${gameData.index - 1}`);
             //console.log(` ⭐⭐ Server is emitting 'numberDrawn' for number: ${number}. Current call length: ${callNumberLength}`);

            io.to(strGameId).emit("numberDrawn", { number, label, gameId: strGameId, callNumberLength: callNumberLength });

        } catch (error) {
            console.error(`❌ Error during drawing interval for game ${strGameId}:`, error);
            clearInterval(state.drawIntervals[strGameId]);
            delete state.drawIntervals[strGameId];
            // Potentially call resetRound or resetGame here on critical error,
            // depending on how severe the error is and if it makes the game unrecoverable.
            // A comprehensive reset (like resetRound) might be appropriate here too.
            await resetRound(strGameId, GameSessionId, socket, io, state, redis); // Added for robust error handling
            io.to(strGameId).emit("gameEnded", { gameId: strGameId, message: "Game ended due to drawing error." });
        }
    }, 3000); // Draw every 3 seconds
}




    //check winner

    socket.on("checkWinner", async ({ telegramId, gameId, GameSessionId, cartelaId, selectedNumbers}) => {
        const selectedSet = new Set((selectedNumbers || []).map(Number));

        try {

            // Validate cartelaId
            const numericCardId = Number(cartelaId);
            if (isNaN(numericCardId)) {
                socket.emit("winnerError", { message: "Invalid or missing card ID." });
                console.error("❌ checkWinner: cartelaId is NaN or invalid:", cartelaId);
                return;
            }

            // 1. Get drawn numbers as list from Redis and get the last number
            const drawnNumbersRaw = await redis.lRange(`gameDraws:${GameSessionId}`, 0, -1);
            if (!drawnNumbersRaw || drawnNumbersRaw.length === 0) {
                socket.emit("winnerError", { message: "No numbers have been drawn yet." });
                return;
            }
            
            // Corrected logic: get the last number from the raw array before creating the Set
            const drawnNumbersArray = drawnNumbersRaw.map(Number);
            const lastTwoDrawnNumbers = drawnNumbersArray.slice(-2);
            const drawnNumbers = new Set(drawnNumbersArray);
            // 2. Fetch the official card from DB
            const cardData = await GameCard.findOne({ gameId, cardId: Number(cartelaId) });
            if (!cardData) {
                socket.emit("winnerError", { message: "Card not found." });
                return;
            }

            console.log("✅ drawnNumbers:", drawnNumbers);
            console.log("✅ selectedNumbers (marked):", selectedSet);
            console.log("✅ cardData.card:", cardData.card);

            // 3. Backend pattern check function
            const pattern = checkBingoPattern(cardData.card, drawnNumbers, selectedSet);
            const isWinner = pattern.some(Boolean); // ✅ Check if any cell is true

            if (!isWinner) {
                socket.emit("winnerError", { message: "No winning pattern found." });
                return;
            }
                // ✨ NEW VALIDATION STEP (UPDATED) ✨
                const flatCard = cardData.card.flat();
                let isRecentNumberInPattern = false;

                // Check if any of the last two drawn numbers are in the winning pattern
                for (const recentNumber of lastTwoDrawnNumbers) {
                    // Check if the current recent number is in the winning pattern
                    if (flatCard.some((number, index) => pattern[index] && number === recentNumber)) {
                        isRecentNumberInPattern = true;
                        break; // Found a match, no need to check other numbers
                    }
                }

               // Server-side code
                if (!isRecentNumberInPattern) {
                    console.log("❌ Winner not confirmed: Winning pattern not completed by a recent drawn number.");
                    socket.emit("bingoClaimFailed", {
                        message: "Your winning pattern was not completed by the last two drawn numbers. 😢",
                        reason: "recent_number_mismatch",
                        telegramId,
                        gameId,
                        cardId: cartelaId,
                        card: cardData.card,          // ✅ Include the player's card
                        lastTwoNumbers: lastTwoDrawnNumbers, // ✅ Include the last two drawn numbers
                        selectedNumbers: selectedNumbers // ✅ Include the player's selected numbers
                    });
                    return;
                }

                const winnerLockKey = `winnerLock:${GameSessionId}`;

                // Try to set the lock. 'NX' means 'Not eXists'.
              const lockAcquired = await redis.set(winnerLockKey, telegramId, {
                                            EX: 20,
                                            NX: true
                                        });
                if (!lockAcquired) {
                    // This player passed all checks but was not the first to set the lock.
                   // socket.emit("winnerError", { message: "Another valid winner was processed first." });
                    return;
                }

            // 4. If winner confirmed, call internal winner processing function
            await processWinner({ telegramId, gameId, GameSessionId, cartelaId, io, selectedSet, state, redis });


            //socket.emit("winnerConfirmed", { message: "Winner verified and processed!" });

        } catch (error) {
            console.error("Error in checkWinner:", error);
            socket.emit("winnerError", { message: "Internal error verifying winner." });
        }
    });






   async function processWinner({ telegramId, gameId, GameSessionId, cartelaId, io, selectedSet, state, redis }) {
    const strGameId = String(gameId);
    const strGameSessionId = String(GameSessionId);

    console.log("Processing winner for game session:", strGameSessionId);

    // Use the GameSessionId directly. No need for a Redis lookup.
    // The previous code block that looked up the sessionId is removed.
    
    try {
        const gameData = await GameControl.findOne({ GameSessionId: strGameSessionId });
        if (!gameData) {
            throw new Error(`GameControl data not found for GameSessionId ${strGameSessionId}`);
        }

        const prizeAmount = gameData.prizeAmount;
        const houseProfit = gameData.houseProfit;
        const stakeAmount = gameData.stakeAmount;
        const playerCount = gameData.totalCards;

        if (typeof prizeAmount !== "number" || isNaN(prizeAmount)) {
            throw new Error(`Invalid or missing prizeAmount (${prizeAmount}) for gameId: ${strGameId}`);
        }

        const winnerUser = await User.findOne({ telegramId });
        if (!winnerUser) {
            throw new Error(`User with telegramId ${telegramId} not found`);
        }

        // --- Winner Payout ---
        winnerUser.balance = Number(winnerUser.balance || 0) + prizeAmount;
        await winnerUser.save();
        await redis.set(`userBalance:${telegramId}`, winnerUser.balance.toString());

        // --- Card Validation and Pattern Check ---
        const selectedCard = await GameCard.findOne({ gameId: strGameId, cardId: cartelaId });
        const board = selectedCard?.card || [];
        
        const drawn = await redis.lRange(`gameDraws:${strGameSessionId}`, 0, -1);
        const drawnNumbers = new Set(drawn.map(Number));
        const winnerPattern = checkBingoPattern(board, drawnNumbers, selectedSet);

          // ⭐ Fetch the game state to get the last call number length
        const gameDrawStateKey = `gameDrawState:${strGameSessionId}`;
        const gameDataRaw = await redis.get(gameDrawStateKey);
        let callNumberLength = null;
        if (gameDataRaw) {
            const gameData = JSON.parse(gameDataRaw);
            callNumberLength = gameData.callNumberLength || 0;
        }
        

        // ⭐ Record the winner's payout in the ledger
        await Ledger.create({
            gameSessionId: strGameSessionId,
            amount: prizeAmount,
            transactionType: 'player_winnings',
            telegramId: telegramId,
            description: `Winnings for game session ${strGameSessionId}`
        });

        // ⭐ Record the house profit in the ledger
        await Ledger.create({
            gameSessionId: strGameSessionId,
            amount: houseProfit,
            transactionType: 'house_profit',
            description: `House profit from game session ${strGameSessionId}`
        });


        // --- Broadcast Winner & Log History ---
        io.to(strGameId).emit("winnerConfirmed", {
            winnerName: winnerUser.username || "Unknown",
            prizeAmount,
            playerCount,
            boardNumber: cartelaId,
            board,
            winnerPattern,
            telegramId,
            gameId: strGameId,
            GameSessionId: strGameSessionId,
        });

        await GameHistory.create({
            sessionId: strGameSessionId,
            gameId: strGameId,
            username: winnerUser.username || "Unknown",
            telegramId,
            eventType: "win",
            winAmount: prizeAmount,
            stake: stakeAmount,
            cartelaId: cartelaId, // ⭐ Added cartelaId
            callNumberLength: callNumberLength, // ⭐ Added callNumberLength
            createdAt: new Date(),
        });

        // --- Log Losers ---
        const players = await redis.sMembers(`gameRooms:${strGameId}`) || [];
        for (const playerTelegramId of players) {
            if (playerTelegramId !== telegramId) {
                const playerUser = await User.findOne({ telegramId: playerTelegramId });
                const loserCard = await GameCard.findOne({ gameId: strGameId, takenBy: playerTelegramId });
                console.log("looser card🤪🤪", loserCard);
                if (!playerUser) continue;
                await GameHistory.create({
                    sessionId: strGameSessionId,
                    gameId: strGameId,
                    username: playerUser.username || "Unknown",
                    telegramId: playerTelegramId,
                    eventType: "lose",
                    winAmount: 0,
                    stake: stakeAmount,
                    cartelaId: loserCard ? loserCard.cardId : null, 
                    callNumberLength: callNumberLength, // ⭐ Added callNumberLength
                    createdAt: new Date(),
                });
            }
        }
        
        // --- Final Cleanup & State Update ---
        await GameControl.findOneAndUpdate(
            { GameSessionId: strGameSessionId },
            { isActive: false, endedAt: new Date() }
        );
        await syncGameIsActive(strGameId, false);

        await redis.set(`winnerInfo:${strGameSessionId}`, JSON.stringify({
            winnerName: winnerUser.username || "Unknown",
            prizeAmount,
            playerCount,
            boardNumber: cartelaId,
            board,
            winnerPattern,
            telegramId,
            gameId: strGameId
        }), { EX: 60 * 5 });
        
        // --- Final Cleanup using Promise.all ---
        await Promise.all([
            redis.del(`gameRooms:${strGameId}`),
            redis.del(`gameCards:${strGameId}`),
            redis.del(`gameDraws:${strGameSessionId}`),
            redis.del(`gameActive:${strGameId}`),
            redis.del(`countdown:${strGameId}`),
            redis.del(`activeDrawLock:${strGameId}`),
            redis.del(`gameDrawState:${strGameSessionId}`),
        ]);
        
        await GameCard.updateMany({ gameId: strGameId }, { isTaken: false, takenBy: null });

        await resetRound(strGameId, strGameSessionId, socket, io, state, redis);
        io.to(strGameId).emit("gameEnded");

    } catch (error) {
        console.error("🔥 Error processing winner:", error);
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

        // --- Remove the player from the GameControl document ---
        // 🟢 CRITICAL: This removes the player object from the `players` array in the database.
        await GameControl.updateOne(
            { GameSessionId: GameSessionId },
            { $pull: { players: { telegramId: strTelegramId } } }
        );
        console.log(`✅ Player ${telegramId} removed from GameControl document.`);

        // --- Remove from Redis sets and hashes ---
        await Promise.all([
            redis.sRem(`gameSessions:${gameId}`, strTelegramId),
            redis.sRem(`gameRooms:${gameId}`, strTelegramId),
            // The following Redis keys are redundant or not needed based on the new flow.
            // Keeping them for now but they can likely be consolidated.
        ]);

        let userSelectionRaw = await redis.hGet("userSelectionsByTelegramId", strTelegramId);
        let userSelection = userSelectionRaw ? JSON.parse(userSelectionRaw) : null;

        // Free selected card if owned by this player
        if (userSelection?.cardId) {
            const cardOwner = await redis.hGet(`gameCards:${gameId}`, String(userSelection.cardId));
            if (cardOwner === strTelegramId) {
                const dbUpdateResult = await GameCard.findOneAndUpdate(
                    { gameId, cardId: Number(userSelection.cardId) },
                    { isTaken: false, takenBy: null }
                );

                if (dbUpdateResult) {
                    console.log(`✅ DB updated: Card ${userSelection.cardId} released for ${telegramId}`);
                } else {
                    console.warn(`⚠️ DB update failed: Could not find card ${userSelection.cardId} to release`);
                }

                io.to(gameId).emit("cardAvailable", { cardId: userSelection.cardId });
                console.log(`✅ Emitted 'cardAvailable' for card ${userSelection.cardId}`);

                await redis.hDel(`gameCards:${gameId}`, userSelection.cardId);
            }
        }

        // --- Remove userSelections entries by both socket.id and telegramId after usage ---
        await Promise.all([
            redis.hDel("userSelections", socket.id),
            redis.hDel("userSelections", strTelegramId),
            redis.hDel("userSelectionsByTelegramId", strTelegramId),
            redis.sRem(getGameRoomsKey(gameId), strTelegramId),
            deleteCardsByTelegramId(strGameId, strTelegramId),
            redis.del(`activeSocket:${strTelegramId}:${socket.id}`),
        ]);

        // Emit updated player count
        const playerCount = await redis.sCard(`gameRooms:${gameId}`) || 0;
        io.to(gameId).emit("playerCountUpdate", { gameId, playerCount });

        await checkAndResetIfEmpty(gameId, GameSessionId, socket, io, redis, state);

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
        let userPayload = null;
        let disconnectedPhase = null;
        let strTelegramId = null;
        let strGameId = null;
        let strGameSessionId = null;

        // Use Redis multi() to batch initial reads
        const [userSelectionPayloadRaw, joinGamePayloadRaw] = await redis.multi()
            .hGet("userSelections", socket.id)
            .hGet("joinGameSocketsInfo", socket.id)
            .exec();


            console.log("joinsocket info 🔥🔥 inside disconnect  userSelectionPayloadRaw", userSelectionPayloadRaw, "joingame payloadra", joinGamePayloadRaw ); 

        const payload = JSON.parse(joinGamePayloadRaw);

        // Access the GameSessionId property
        const gameSessionId = String(payload.GameSessionId);

        // 1. Try to retrieve info from 'lobby' phase first
        if (userSelectionPayloadRaw) {
            userPayload = safeJsonParse(userSelectionPayloadRaw, "userSelections", socket.id);
            if (userPayload) {
                disconnectedPhase = userPayload.phase || 'lobby';
            } else {
                await redis.hDel("userSelections", socket.id);
            }
        }

        // 2. If not found in 'lobby', try 'joinGame' phase
        if (!userPayload && joinGamePayloadRaw) {
            userPayload = safeJsonParse(joinGamePayloadRaw, "joinGameSocketsInfo", socket.id);
            if (userPayload) {
                disconnectedPhase = userPayload.phase || 'joinGame';
            } else {
                await redis.hDel("joinGameSocketsInfo", socket.id);
            }
        }

        // 3. Early exit if crucial info is missing
        if (!userPayload || !userPayload.telegramId || !userPayload.gameId || !disconnectedPhase) {
            console.log("❌ No relevant user session info found or payload corrupted for this disconnected socket ID. Skipping full disconnect cleanup.");
            await redis.del(`activeSocket:${socket.handshake.query.telegramId || 'unknown'}:${socket.id}`);
            return;
        }

        // Assign universal variables from the payload
        strTelegramId = String(userPayload.telegramId);
        strGameId = String(userPayload.gameId);
        // Ensure GameSessionId is assigned, defaulting if not present (e.g., in a lobby)
        strGameSessionId = userPayload.GameSessionId || 'NO_SESSION_ID';

        console.log(`[DISCONNECT DEBUG] Processing disconnect for User: ${strTelegramId}, Game: ${strGameId}, Socket: ${socket.id}, Final Deduced Phase: ${disconnectedPhase}`);

        // --- Initial cleanup for the specific disconnected socket ---
        await redis.del(`activeSocket:${strTelegramId}:${socket.id}`);

        // --- Determine remaining active sockets for this user in THIS specific phase ---
        const allActiveSocketKeysForUser = await redis.keys(`activeSocket:${strTelegramId}:*`);
        const otherSocketIds = allActiveSocketKeysForUser
            .map(key => key.split(':').pop())
            .filter(id => id !== socket.id);

        const otherSocketPayloadsRaw = otherSocketIds.length > 0 ?
            await redis.multi(otherSocketIds.map(id => [
                'hGet',
                disconnectedPhase === 'lobby' ? 'userSelections' : 'joinGameSocketsInfo',
                id
            ])).exec() : [];

        let remainingSocketsForThisPhaseCount = 0;
        let staleKeysToDelete = [];

        for (let i = 0; i < otherSocketIds.length; i++) {
            const otherSocketId = otherSocketIds[i];
            const payload = otherSocketPayloadsRaw[i] && otherSocketPayloadsRaw[i][1];

            const otherSocketInfo = safeJsonParse(payload, 'otherSocket', otherSocketId);

            if (otherSocketInfo && String(otherSocketInfo.gameId) === strGameId && (otherSocketInfo.phase || 'lobby') === disconnectedPhase) {
                remainingSocketsForThisPhaseCount++;
            } else {
                staleKeysToDelete.push(`activeSocket:${strTelegramId}:${otherSocketId}`);
            }
        }

        if (staleKeysToDelete.length > 0) {
            await redis.del(...staleKeysToDelete);
            console.log(`🧹 Cleaned up ${staleKeysToDelete.length} stale activeSocket keys.`);
        }

        console.log(`[DISCONNECT DEBUG] Remaining active sockets for ${strTelegramId} in game ${strGameId} in phase '${disconnectedPhase}': ${remainingSocketsForThisPhaseCount}`);

                  // ⭐ Add the update query here ⭐
                // This updates the player's status to 'disconnected' in the database
                // if (reason === "transport close"){
                //     console.log("reason", reason, "for", strTelegramId, "➖➖");
                //     await GameControl.updateOne(
                //         { GameSessionId: strGameSessionId, 'players.telegramId': strTelegramId },
                //         { '$set': { 'players.$.status': 'disconnected' } }
                //     );
                // }

        // --- Grace Period and Cleanup based on the user's last remaining socket for this phase ---
        const timeoutKeyForPhase = `${strTelegramId}:${strGameId}:${disconnectedPhase}`;

        if (pendingDisconnectTimeouts.has(timeoutKeyForPhase)) {
            clearTimeout(pendingDisconnectTimeouts.get(timeoutKeyForPhase));
            pendingDisconnectTimeouts.delete(timeoutKeyForPhase);
            console.log(`🕒 Cleared existing pending disconnect timeout for ${timeoutKeyForPhase}.`);
        }

        if (remainingSocketsForThisPhaseCount === 0) {
            let cleanupFunction;
            let gracePeriodDuration;

            if (disconnectedPhase === 'lobby') {
                cleanupFunction = cleanupLobbyPhase;
                gracePeriodDuration = ACTIVE_DISCONNECT_GRACE_PERIOD_MS;
            } else if (disconnectedPhase === 'joinGame') {
                cleanupFunction = cleanupJoinGamePhase;
                gracePeriodDuration = JOIN_GAME_GRACE_PERIOD_MS;
            }

            if (cleanupFunction) {
                const timeoutId = setTimeout(async () => {
                    try {
                            console.log(`[DEBUG] Attempting to update GameSessionId: ${gameSessionId} for player: ${strTelegramId}`);
                            console.log("reason", reason, "inside cleanupfunction", strTelegramId, "➖➖");
                           if (gameSessionId) {
                            const result = await GameControl.updateOne(
                                // Verify telegramId is a number if that's the schema type, otherwise remove Number()
                                { GameSessionId: gameSessionId, 'players.telegramId': Number(strTelegramId) }, 
                                { '$set': { 'players.$.status': 'disconnected' } }
                            );
                            console.log(`✅ Player ${strTelegramId} status updated to 'disconnected'. Result:`, result);

                        const userUpdateResult = await User.findOneAndUpdate(
                            // Use the top-level telegramId field to find the user
                            { telegramId: Number(strTelegramId) },
                            { $set: { reservedForGameId: null } }
                        );
                          console.log(`👴 Player ${strTelegramId} reservedGameId`, userUpdateResult);

                        }
                        await cleanupFunction(strTelegramId, strGameId, strGameSessionId, io, redis);
                    } catch (e) {
                        console.error(`❌ Error during grace period cleanup for ${timeoutKeyForPhase}:`, e);
                    } finally {
                        pendingDisconnectTimeouts.delete(timeoutKeyForPhase);
                    }
                }, gracePeriodDuration);

                pendingDisconnectTimeouts.set(timeoutKeyForPhase, timeoutId);
                console.log(`🕒 User ${strTelegramId} has no remaining active sockets for game ${strGameId} in '${disconnectedPhase}' phase. Starting ${gracePeriodDuration / 1000}-second grace period timer.`);
            }
        } else {
            console.log(`ℹ️ ${strTelegramId} still has ${remainingSocketsForThisPhaseCount} other active sockets for game ${strGameId} in phase '${disconnectedPhase}'. No grace period timer started for this phase.`);
        }
    } catch (e) {
        console.error(`❌ CRITICAL ERROR in disconnect handler for socket ${socket.id}:`, e);
    }
});

// --- Modular Cleanup Functions (Self-contained and robust) ---

const cleanupLobbyPhase = async (strTelegramId, strGameSessionId, strGameId, _, io, redis) => {
    console.log(`⏱️ Lobby grace period expired for User: ${strTelegramId}, Game: ${strGameId}. Performing cleanup.`);

    const gameCardsKey = `gameCards:${strGameId}`;

    // 1️⃣ Get the last selected card from Redis
    const userOverallSelectionRaw = await redis.hGet("userSelectionsByTelegramId", strTelegramId);
    let userHeldCardId = null;
    if (userOverallSelectionRaw) {
        const parsed = safeJsonParse(userOverallSelectionRaw);
        if (parsed?.cardId) userHeldCardId = parsed.cardId;
    }

    // 2️⃣ Always check DB for any card taken by this user in this game
    const dbCard = await GameCard.findOne({ gameId: strGameId, takenBy: strTelegramId });

    if (userHeldCardId || dbCard) {
        const cardToRelease = userHeldCardId || dbCard.cardId;
        await redis.hDel(gameCardsKey, String(cardToRelease));
        await GameCard.findOneAndUpdate(
            { gameId: strGameId, cardId: Number(cardToRelease) },
            { isTaken: false, takenBy: null }
        );
        io.to(strGameId).emit("cardReleased", { cardId: Number(cardToRelease), telegramId: strTelegramId });
        console.log(`✅ Card ${cardToRelease} released for ${strTelegramId} due to grace period expiry.`);
    }

    // 3️⃣ Remove user from sets & Redis maps
    await redis.multi()
        .sRem(`gameSessions:${strGameId}`, strTelegramId)
        .sRem(`gamePlayers:${strGameId}`, strTelegramId)
        .hDel("userSelectionsByTelegramId", strTelegramId)
        .exec();

    // 4️⃣ Broadcast updated counts
    const numberOfPlayersLobby = await redis.sCard(`gameSessions:${strGameId}`) || 0;
    io.to(strGameId).emit("gameid", { gameId: strGameId, numberOfPlayers: numberOfPlayersLobby });

    // 5️⃣ Reset game if empty
    const totalPlayersGamePlayers = await redis.sCard(`gamePlayers:${strGameId}`);
    if (numberOfPlayersLobby === 0 && totalPlayersGamePlayers === 0) {
        await GameControl.findOneAndUpdate({ gameId: strGameId }, { isActive: false, totalCards: 0, players: [], endedAt: new Date() });
        await syncGameIsActive(strGameId, false);
        resetGame(strGameId, strGameSessionId, io, state, redis);
        console.log(`🧹 Game ${strGameId} fully reset.`);
    }
};


const cleanupJoinGamePhase = async (strTelegramId, strGameId, strGameSessionId, io, redis) => {
    let retries = 3;

    while (retries > 0) {
        try {
            console.log(`⏱️ JoinGame grace period expired for User: ${strTelegramId}, Game: ${strGameId}. Performing joinGame-specific cleanup.`);

            // 🟢 MODIFIED: We are now finding the player record and setting their status to 'disconnected'.
            const gameControl = await GameControl.findOneAndUpdate(
                { GameSessionId: strGameSessionId, 'players.telegramId': Number(strTelegramId) },
                { $set: { 'players.$.status': 'disconnected' } },
                { new: true, upsert: false } // upsert: false to avoid creating a new player.
            );

            if (gameControl) {
                 console.log("🕸️🕸️🏠 player status updated to 'disconnected'", strGameId, strTelegramId);
            } else {
                 console.warn(`GameControl document or player not found for cleanup: ${strGameId} (Session: ${strGameSessionId})`);
            }

            break; // If successful, exit the loop.
        } catch (e) {
            if (e.name === 'VersionError') {
                console.warn(`Version conflict detected during cleanup for ${strTelegramId}:${strGameId}. Retrying... (${retries - 1} left)`);
                retries--;
                continue; // Retry the operation
            } else {
                console.error(`❌ CRITICAL ERROR during grace period cleanup for ${strTelegramId}:${strGameId}:`, e);
                throw e;
            }
        }
    }

    // This section of cleanup is for Redis and other parts of the application.
    await redis.sRem(`gameRooms:${strGameId}`, strTelegramId);
    console.log("➖➖ remove player from the gameroom redis",`gameRooms:${strGameId}`);

    const playerCount = await redis.sCard(`gameRooms:${strGameId}`);
    io.to(strGameId).emit("playerCountUpdate", { gameId: strGameId, playerCount });
    console.log(`📊 Broadcasted counts for game ${strGameId}: Total Players = ${playerCount} after joinGame grace period cleanup.`);

    const userOverallSelectionRaw = await redis.hGet("userSelectionsByTelegramId", strTelegramId);
    if (userOverallSelectionRaw) {
        const { cardId: userHeldCardId, gameId: selectedGameId } = safeJsonParse(userOverallSelectionRaw);
        if (String(selectedGameId) === strGameId && userHeldCardId) {
            const gameCardsKey = `gameCards:${strGameId}`;
            const cardOwner = await redis.hGet(gameCardsKey, String(userHeldCardId));
            if (cardOwner === strTelegramId) {
                await redis.hDel(gameCardsKey, String(userHeldCardId));
                await GameCard.findOneAndUpdate({ gameId: strGameId, cardId: Number(userHeldCardId) }, { isTaken: false, takenBy: null });
                io.to(strGameId).emit("cardReleased", { cardId: Number(userHeldCardId), telegramId: strTelegramId });
                console.log(`✅ Card ${userHeldCardId} released for ${strTelegramId} (disconnected from joinGame).`);
            }
        }
    }
    await redis.hDel("userSelectionsByTelegramId", strTelegramId);

    await User.findOneAndUpdate({ telegramId: strTelegramId, reservedForGameId: strGameId }, { $unset: { reservedForGameId: "" } });

    if (playerCount === 0) {
        console.log(`✅ All players have left game room ${strGameId}. Calling resetRound.`);
        resetRound(strGameId, strGameSessionId, socket, io, state, redis);
    }

    const totalPlayersGamePlayers = await redis.sCard(`gamePlayers:${strGameId}`);
    const numberOfPlayersLobby = await redis.sCard(`gameSessions:${strGameId}`) || 0;
    if (playerCount === 0 && numberOfPlayersLobby === 0 && totalPlayersGamePlayers === 0) {
        console.log(`🧹 Game ${strGameId} empty after joinGame phase grace period. Triggering full game reset.`);
            await GameControl.findOneAndUpdate(
            { gameId: strGameId, GameSessionId: strGameSessionId },
            {
                $set: {
                isActive: false,
                totalCards: 0,
                players: [],
                endedAt: new Date(),
                }
            }
            );
        await syncGameIsActive(strGameId, false);
        resetGame(strGameId,strGameSessionId, io, state, redis);
        console.log(`Game ${strGameId} has been fully reset.`);
    }
};

  });
};





         