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

      // ✅ Send a heartbeat to all connected clients every 5 seconds
        setInterval(() => {
        io.emit("heartbeat", Date.now());
        }, 3000);       

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


  // ⬇️ REPLACEMENT "cardSelected" HANDLER (SUPPORTS MULTI-CARD + UPSERT) ⬇️
    socket.on("cardSelected", async (data) => {
        // --- 1. Data Sanitization & Key Preparation ---
        const { telegramId, gameId, cardIds, requestId } = data;

        const strTelegramId = String(telegramId);
        const strGameId = String(gameId);
        const userActionLockKey = `lock:userAction:${strGameId}:${strTelegramId}`;
        const gameCardsKey = `gameCards:${strGameId}`;
        const userSelectionsKey = `userSelections`;
        const userSelectionsByTelegramIdKey = `userSelectionsByTelegramId`;
        const userLastRequestIdKey = `userLastRequestId`;

        const desiredCardIds = (Array.isArray(cardIds) ? cardIds : [cardIds])
                                .map(Number)
                                .filter(id => !isNaN(id) && id > 0);

        // --- 2. Acquire User-Level Lock ---
        const userLock = await redis.set(userActionLockKey, requestId, "NX", "EX", 10);
        if (!userLock) {
            return socket.emit("cardError", {
                message: "⏳ Your previous action is still processing. Please wait a moment.",
                requestId,
                currentHeldCardIds: [] 
            });
        }

        try {
            // --- 3. Get User's CURRENTLY HELD cards from DB ---
            const currentlyHeldCards = await GameCard.find({
                gameId: strGameId,
                takenBy: strTelegramId
            });
            const currentlyHeldCardIds = currentlyHeldCards.map(c => c.cardId);

            // --- 4. Determine which cards to RELEASE and which to ACQUIRE ---
            const cardsToRelease = currentlyHeldCardIds.filter(id => !desiredCardIds.includes(id));
            const cardsToAcquire = desiredCardIds.filter(id => !currentlyHeldCardIds.includes(id));
            
            // --- 5. Check Availability of cards to ACQUIRE ---
            if (cardsToAcquire.length > 0) {
                const unavailableCards = await GameCard.find({
                    gameId: strGameId,
                    cardId: { $in: cardsToAcquire },
                    isTaken: true,
                    takenBy: { $ne: strTelegramId } 
                });

                if (unavailableCards.length > 0) {
                    socket.emit("cardUnavailable", { 
                        cardId: unavailableCards[0].cardId,
                        currentHeldCardIds: currentlyHeldCardIds,
                        requestId 
                    });
                    return; 
                }
            }

            // --- 6. Perform the Atomic Update ---
            const dbPromises = [];
            const redisMulti = redis.multi();
            
            // A) Release old cards
            if (cardsToRelease.length > 0) {
                dbPromises.push(
                    GameCard.updateMany(
                        { gameId: strGameId, cardId: { $in: cardsToRelease }, takenBy: strTelegramId },
                        { $set: { isTaken: false, takenBy: null } }
                    )
                );
                cardsToRelease.forEach(id => {
                    redisMulti.hDel(gameCardsKey, String(id));
                    socket.to(strGameId).emit("cardReleased", { 
                        cardId: String(id), 
                        telegramId: strTelegramId 
                    });
                });
            }

            // B) Acquire new cards (using a loop to allow for UPSERT)
            // ⭐️ THIS IS THE CORE FIX ⭐️
            if (cardsToAcquire.length > 0) {
                cardsToAcquire.forEach(idToAcquire => {
                    // For each new card, run an updateOne with upsert: true
                    dbPromises.push(
                        GameCard.updateOne(
                            { gameId: strGameId, cardId: idToAcquire },
                            { $set: { isTaken: true, takenBy: strTelegramId, gameId: strGameId, cardId: idToAcquire } },
                            { upsert: true } // This creates the card if it doesn't exist
                        )
                    );
                    
                    redisMulti.hSet(gameCardsKey, String(idToAcquire), strTelegramId);
                    socket.to(strGameId).emit("otherCardSelected", { 
                        telegramId: strTelegramId, 
                        cardId: String(idToAcquire) 
                    });
                });
            }

            // --- 7. Update User's Overall Selection State in Redis ---
            const selectionData = JSON.stringify({
                telegramId: strTelegramId,
                cardIds: desiredCardIds, // Store the full array
                gameId: strGameId
            });
            redisMulti.hSet(userSelectionsKey, socket.id, selectionData);
            redisMulti.hSet(userSelectionsByTelegramIdKey, strTelegramId, selectionData);
            redisMulti.hSet(userLastRequestIdKey, strTelegramId, requestId);

            // Execute all DB and Redis commands
            await Promise.all([
                ...dbPromises,
                redisMulti.exec()
            ]);

            // --- 8. Broadcast Updates & Confirmations ---
            socket.emit("cardConfirmed", { 
                cardIds: desiredCardIds,
                requestId 
            });

            const [updatedSelections, numberOfPlayers] = await Promise.all([
                redis.hGetAll(gameCardsKey),
                redis.sCard(`gameSessions:${strGameId}`)
            ]);

            io.to(strGameId).emit("currentCardSelections", updatedSelections);
            io.to(strGameId).emit("gameid", { gameId: strGameId, numberOfPlayers });

        } catch (err) {
            console.error(`❌ cardSelected error for game ${strGameId}, user ${strTelegramId}:`, err);
            socket.emit("cardError", { 
                message: err.message || "An unexpected error occurred. Please try again.", 
                requestId,
                currentHeldCardIds: []
            });
        } finally {
            // --- 9. Release All Locks ---
            await redis.del(userActionLockKey);
        }
    });
    // ⬆️ END REPLACEMENT HANDLER ⬆️



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

     if (state.countdownIntervals[strGameId]) {
        console.log(`⏳ Countdown for game ${strGameId} is already running. Ignoring new 'gameCount' trigger.`);
        return; // Exit the function immediately
    }

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
        let countdownValue = 30;
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
    const currentGameControl = await GameControl.findOne({ GameSessionId: strGameSessionId }).select('players -_id');

    // ⭐ Step 2: Filter the player list to get only those with a 'connected' status
    const connectedPlayers = (currentGameControl?.players || []).filter(p => p.status === 'connected');

    const playersForDeduction = connectedPlayers.map(player => player?.telegramId).filter(Boolean);
    console.log("player connected are 🤑🤑", playersForDeduction);
    let successfulDeductions = 0;
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
            let user = null;
            let deductionSuccessful = false;

            // 🟢 ATTEMPT 1: Deduct from bonus_balance first
            user = await User.findOneAndUpdate(
                { telegramId: playerTelegramId, reservedForGameId: strGameId, bonus_balance: { $gte: stakeAmount } },
                { $inc: { bonus_balance: -stakeAmount }, $unset: { reservedForGameId: "" } },
                { new: true }
            );

            if (user) {
                deductionSuccessful = true;
                // Log bonus deduction to ledger
                await Ledger.create({
                    gameSessionId: strGameSessionId,
                    amount: -stakeAmount,
                    transactionType: 'bonus_stake_deduction',
                    telegramId: playerTelegramId,
                    description: `Bonus stake deduction for game session ${strGameSessionId}`
                });
            } else {
                // 🟢 ATTEMPT 2: If bonus deduction fails, deduct from regular balance
                user = await User.findOneAndUpdate(
                    { telegramId: playerTelegramId, reservedForGameId: strGameId, balance: { $gte: stakeAmount } },
                    { $inc: { balance: -stakeAmount }, $unset: { reservedForGameId: "" } },
                    { new: true }
                );

                if (user) {
                    deductionSuccessful = true;
                    // Log regular balance deduction to ledger
                    await Ledger.create({
                        gameSessionId: strGameSessionId,
                        amount: -stakeAmount,
                        transactionType: 'stake_deduction',
                        telegramId: playerTelegramId,
                        description: `Stake deduction from main balance for game session ${strGameSessionId}`
                    });
                }
            }

            // If a deduction was successful (either from bonus or main balance)
            if (deductionSuccessful) {
                successfulDeductions++;
                successfullyDeductedPlayers.push(playerTelegramId);
                finalPlayerObjects.push({ telegramId: playerTelegramId, status: 'connected' });
                await redis.set(`userBalance:${playerTelegramId}`, user.balance.toString(), "EX", 60);
                await redis.set(`userBonusBalance:${playerTelegramId}`, user.bonus_balance.toString(), "EX", 60);
            } else {
                // No deduction was possible, so cleanup the user's state
                await User.updateOne({ telegramId: playerTelegramId }, { $unset: { reservedForGameId: "" } });
                await redis.sRem(getGameRoomsKey(strGameId), playerTelegramId.toString());
                await GameControl.updateOne({ GameSessionId: strGameSessionId }, { $pull: { players: { telegramId: playerTelegramId } } });
                console.log(`🛑 User ${playerTelegramId} did not have sufficient funds (bonus or real). Skipping.`);
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

    const activePlayersKey = `activePlayers:${strGameSessionId}`;
    if (successfullyDeductedPlayers.length > 0) {
        const playerIdsAsStrings = successfullyDeductedPlayers.map(String);
        await redis.sAdd(activePlayersKey, playerIdsAsStrings);
        await redis.expire(activePlayersKey, 3600);
    }

    const totalPot = stakeAmount * successfulDeductions;
    const houseProfit = totalPot * HOUSE_CUT_PERCENTAGE;
    const prizeAmount = totalPot - houseProfit;

    await GameControl.findOneAndUpdate(
        { GameSessionId: strGameSessionId },
        {
            $set: {
                isActive: true,
                totalCards: successfulDeductions,
                prizeAmount: prizeAmount,
                houseProfit: houseProfit,
                players: finalPlayerObjects
            }
        }
    );
    await syncGameIsActive(strGameId, true);

    delete state.activeDrawLocks[strGameId];
    await redis.del(getActiveDrawLockKey(strGameId));

    console.log(`🧹 Releasing all selected cards for game ${strGameId}...`);
    const gameCardsKey = `gameCards:${strGameId}`;

    try {
        const allSelectedCards = await redis.hGetAll(gameCardsKey);
        await redis.del(gameCardsKey);
        await GameCard.updateMany(
            { gameId: strGameId, cardId: { $in: Object.keys(allSelectedCards).map(Number) } },
            { $set: { isTaken: false, takenBy: null } }
        );
        io.to(strGameId).emit("gameCardResetOngameStart");
    } catch (error) {
        console.error(`❌ Error releasing cards on game start for game ${strGameId}:`, error);
    }
    console.log(`✅ All cards released for game ${strGameId}.`);

    const totalDrawingLength = 75;

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
async function refundStakes(playerIds, strGameSessionId, stakeAmount, redis) {
    for (const playerId of playerIds) {
        try {
            // 1. Find the original deduction record from the ledger
            const deductionRecord = await Ledger.findOne({
                telegramId: playerId,
                gameSessionId: strGameSessionId,
                transactionType: { $in: ['stake_deduction', 'bonus_stake_deduction'] }
            });

            let updateQuery;
            let refundTransactionType;
            let wasBonus = false;

            // 2. Determine which balance to refund based on the record
            if (deductionRecord && deductionRecord.transactionType === 'bonus_stake_deduction') {
                // Player paid with BONUS, so refund to BONUS balance
                updateQuery = { $inc: { bonus_balance: stakeAmount }, $unset: { reservedForGameId: "" } };
                refundTransactionType = 'bonus_stake_refund';
                wasBonus = true;
                console.log(`Player ${playerId} paid with bonus. Preparing bonus refund.`);
            } else {
                // Player paid with MAIN, or we couldn't find a record (safe fallback)
                updateQuery = { $inc: { balance: stakeAmount }, $unset: { reservedForGameId: "" } };
                refundTransactionType = 'stake_refund';
                 if (!deductionRecord) {
                    console.warn(`⚠️ Ledger record not found for player ${playerId}. Defaulting to main balance refund.`);
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
                    amount: stakeAmount,
                    transactionType: refundTransactionType,
                    telegramId: playerId,
                    description: `Stake refund for cancelled game session ${strGameSessionId}`
                });
                console.log(`✅ Successfully refunded ${stakeAmount} to ${wasBonus ? 'bonus' : 'main'} balance for player ${playerId}.`);
            } else {
                console.error(`❌ Could not find user ${playerId} to process refund.`);
            }

        } catch (error) {
            console.error(`❌ Error processing refund for player ${playerId}:`, error);
        }
    }
}

// Helper to perform a full cleanup of game state
async function fullGameCleanup(gameId, redis, state) {
    console.log("fullGameCleanup 🔥🔥🔥");
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

  try {
    // --- 1️⃣ Parallelize initial data fetching (Critical Path) ---
    const [gameControl, winnerUser, gameDrawStateRaw, players] = await Promise.all([
      GameControl.findOne({ GameSessionId: strGameSessionId }),
      User.findOne({ telegramId }),
      redis.get(`gameDrawState:${strGameSessionId}`), 
      redis.sMembers(`gameRooms:${strGameId}`) // Needed for immediate winner announcement
    ]);

    if (!gameControl || !winnerUser) throw new Error("Missing game or user data");

    // --- 2️⃣ Use cached data (Critical Path) ---
    const { prizeAmount, houseProfit, stakeAmount, totalCards: playerCount } = gameControl;
    const board = cardData.card;
    const winnerPattern = checkBingoPattern(board, new Set(drawnNumbersRaw.map(Number)), selectedSet);
    const callNumberLength = gameDrawStateRaw ? JSON.parse(gameDrawStateRaw)?.callNumberLength || 0 : 0;

    // --- 3️⃣ Broadcast winner information (IMMEDIATE RESPONSE TO WINNER) ---
    // This is now done FIRST to achieve immediate confirmation to the user,
    // before the slower, critical financial commits start.
    io.to(strGameId).emit("winnerConfirmed", { winnerName: winnerUser.username || "Unknown", prizeAmount, playerCount, boardNumber: cartelaId, board, winnerPattern, telegramId, gameId: strGameId, GameSessionId: strGameSessionId });

    // --- 4️⃣ Parallel DB & Redis writes for winner/house (CRITICAL Financial Commit) ---
    // We await this to guarantee financial integrity before declaring the main request complete.
    await Promise.all([
      // Financial updates for winner (DB and Redis)
      User.updateOne({ telegramId }, { $inc: { balance: prizeAmount } }),
      redis.incrByFloat(`userBalance:${telegramId}`, prizeAmount),
      Ledger.create({ gameSessionId: strGameSessionId, amount: prizeAmount, transactionType: 'player_winnings', telegramId }),
      // Financial update for house/system
      Ledger.create({ gameSessionId: strGameSessionId, amount: houseProfit, transactionType: 'house_profit' }),
      // History tracking for winner
      GameHistory.create({ sessionId: strGameSessionId, gameId: strGameId, username: winnerUser.username || "Unknown", telegramId, eventType: "win", winAmount: prizeAmount, stake: stakeAmount, cartelaId, callNumberLength })
    ]);

    // --------------------------------------------------------------------------------
    // ⚡ DEFERRED PROCESS: This heavy block runs asynchronously WITHOUT awaiting 
    // so the primary request can return quickly (<100ms).
    // --------------------------------------------------------------------------------
    (async () => {
      try {
        // --- 5️⃣ Batch process losers for history (Heavy) ---
        const loserIds = players.filter(id => id !== telegramId).map(Number);
        if (loserIds.length > 0) {
          // Fetch necessary data for losers in parallel (2 DB calls total)
          const [loserUsers, loserCards] = await Promise.all([
            User.find({ telegramId: { $in: loserIds } }, 'telegramId username'),
            GameCard.find({ gameId: strGameId, takenBy: { $in: loserIds } }, 'takenBy cardId')
          ]);
          
          // Create in-memory maps
          const userMap = new Map(loserUsers.map(u => [u.telegramId, u]));
          const cardMap = new Map(loserCards.map(c => [c.takenBy, c]));

          // Build history documents in memory
          const loserDocs = loserIds.map(id => ({
            sessionId: strGameSessionId,
            gameId: strGameId,
            username: userMap.get(id)?.username || "Unknown",
            telegramId: id,
            eventType: "lose",
            winAmount: 0,
            stake: stakeAmount,
            cartelaId: cardMap.get(id)?.cardId || null,
            callNumberLength,
            createdAt: new Date()
          }));

          // Batch insert all loser records
          await GameHistory.insertMany(loserDocs);
        }

        // --- 6️⃣ Final state cleanup and transition (Optimization: Redis Pipelining) ---
        const cleanupTasks = [
          // Update game status in DB
          GameControl.findOneAndUpdate({ GameSessionId: strGameSessionId }, { isActive: false, endedAt: new Date() }),
          syncGameIsActive(strGameId, false),
          // Cache winner info for short-term display
          redis.set(`winnerInfo:${strGameSessionId}`, JSON.stringify({ winnerName: winnerUser.username || "Unknown", prizeAmount, playerCount, boardNumber: cartelaId, board, winnerPattern, telegramId, gameId: strGameId }), { EX: 300 }),
          // Transition to the next round
           resetRound(strGameId, strGameSessionId, socket, io, state, redis)
        ];
        
        // ⚡ Un-awaited Card Reset: Run the potentially heavy updateMany in the background.
        // If this is slow, it won't block the next round's start.
        GameCard.updateMany({ gameId: strGameId }, { isTaken: false, takenBy: null }).catch(err => console.error("Async Card Reset Error:", err));

        // Use Redis Pipelining to send all DEL commands in a single round trip
        const redisPipeline = redis.multi();
        redisPipeline.del(
          `gameRooms:${strGameId}`,
          `gameCards:${strGameId}`,
          `gameDraws:${strGameSessionId}`,
          `gameActive:${strGameId}`,
          `countdown:${strGameId}`,
          `activeDrawLock:${strGameId}`,
          `gameDrawState:${strGameSessionId}`,
          winnerLockKey // Ensures distributed lock is released immediately
        );
        cleanupTasks.push(redisPipeline.exec());

        await Promise.all(cleanupTasks);
        
        io.to(strGameId).emit("gameEnded");

      } catch (error) {
        console.error("🔥 Deferred Cleanup Error:", error);
        // Note: Errors here do not break the winner's main flow, but must be logged
      }
    })(); // Do not await, run in the background

  } catch (error) {
    console.error("🔥 processWinnerOptimized error:", error);
    // Ensure lock is released quickly if critical financial commit fails
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
        let gameSessionId = null;

        // Use Redis multi() to batch initial reads
        const [userSelectionPayloadRaw, joinGamePayloadRaw] = await redis.multi()
            .hGet("userSelections", socket.id)
            .hGet("joinGameSocketsInfo", socket.id)
            .exec();


            console.log("joinsocket info 🔥🔥 inside disconnect  userSelectionPayloadRaw", userSelectionPayloadRaw, "joingame payloadra", joinGamePayloadRaw ); 

     if (joinGamePayloadRaw) {
        try {
            payload = JSON.parse(joinGamePayloadRaw);
            gameSessionId = payload?.GameSessionId ? String(payload.GameSessionId) : null;
        } catch (err) {
            console.warn("⚠️ Failed to parse joinGamePayloadRaw", joinGamePayloadRaw, err);
        }
     }

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
        strGameSessionId = userPayload.GameSessionId|| gameSessionId || 'NO_SESSION_ID';

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
                         const game = await GameControl.findOne({ GameSessionId: gameSessionId });

                     if (game && game.players.every(player => player.status === 'disconnected')) {
                            await GameControl.updateOne(
                                { GameSessionId: gameSessionId },
                                { 
                                    '$set': { 
                                        'isActive': false, 
                                        'endedAt': new Date() 
                                    } 
                                }
                            );
                            console.log(`❗ Game ${game.gameId} has ended due to all players disconnecting.`);

                            await resetRound(strGameId, gameSessionId, socket, io, state, redis);

                            io.to(strGameId).emit("gameEnded", { gameId: strGameId, message: "Game ended due to all players leaving the room." });
                            console.log("🛑🛑 game is cleared in disconnect after all players leave");
                        }
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

const cleanupLobbyPhase = async (strTelegramId, strGameId, strGameSessionId, io, redis) => {
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





         