const User = require("../models/user");
const GameControl = require("../models/GameControl");
const GameHistory = require("../models/GameHistory")
const resetGame = require("../utils/resetGame");
const checkAndResetIfEmpty = require("../utils/checkandreset");
const redis = require("../utils/redisClient");
const  syncGameIsActive = require("../utils/syncGameIsActive");
const GameCard = require('../models/GameCard'); // Your Mongoose models
const checkBingoPattern = require("../utils/BingoPatterns")
const resetRound = require("../utils/resetRound");
const clearGameSessions = require('../utils/clearGameSessions'); // Adjust path as needed
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
const pendingDisconnectTimeouts = new Map(); // Key: `${telegramId}:${gameId}`, Value: setTimeout ID
const ACTIVE_DISCONNECT_GRACE_PERIOD_MS = 2 * 1000; // For card selection lobby (10 seconds)
const JOIN_GAME_GRACE_PERIOD_MS = 10 * 1000; // For initial join/live game phase (5 seconds)
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
  countdownIntervals,
  drawIntervals,
  drawStartTimeouts,
  activeDrawLocks,
  gameDraws,
  gameSessionIds,
  gameIsActive,
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
        const { telegramId, cardId, card, gameId } = data;

        const strTelegramId = String(telegramId);
        const strCardId = String(cardId);
        const strGameId = String(gameId);

        const gameCardsKey = `gameCards:${strGameId}`;
        const userSelectionsKey = `userSelections`;
        const lockKey = `lock:card:${strGameId}:${strCardId}`;

        const cleanCard = card.map(row => row.map(c => (c === "FREE" ? 0 : Number(c))));

        try {
          // 1️⃣ Redis Lock
          const lock = await redis.set(lockKey, strTelegramId, "NX", "EX", 30);
          //console.log("Lock status:", lock); // Should be "OK" or null

          if (!lock) {
            return socket.emit("cardError", {
              message: "⛔️ This card is currently being selected by another player. Try another card."
              
            });
          
          }

          // 2️⃣ Double check Redis AND DB ownership
          const [currentRedisOwner, existingCard] = await Promise.all([
            redis.hGet(gameCardsKey, strCardId),
            GameCard.findOne({ gameId: strGameId, cardId: Number(strCardId) }),
          ]);

          if ((currentRedisOwner && currentRedisOwner !== strTelegramId) ||
              (existingCard?.isTaken && existingCard.takenBy !== strTelegramId)) {
            await redis.del(lockKey);
            return socket.emit("cardUnavailable", { cardId: strCardId });
          }

          // 3️⃣ Update or Create GameCard
          if (existingCard) {
            const updateResult = await GameCard.updateOne(
        {
          gameId: strGameId,
          cardId: Number(strCardId),
          isTaken: false,
        },
        {
          $set: {
            card: cleanCard,
            isTaken: true,
            takenBy: strTelegramId,
          }
        }
          );

          if (updateResult.modifiedCount === 0) {
            // Someone else took it
            await redis.del(lockKey);
            return socket.emit("cardUnavailable", { cardId: strCardId });
          }

          } else {
            try {
              await GameCard.create({
                gameId: strGameId,
                cardId: Number(strCardId),
                card: cleanCard,
                isTaken: true,
                takenBy: strTelegramId
              });
            } catch (err) {
              if (err.code === 11000) {
                await redis.del(lockKey);
                return socket.emit("cardUnavailable", { cardId: strCardId });
              }
              throw err;
            }
          }

          // 4️⃣ Remove previously selected card by this user
 const previousSelectionRaw = await redis.hGet("userSelectionsByTelegramId", strTelegramId); // <-- FIX THIS LINE!


          if (previousSelectionRaw) {
            const prev = JSON.parse(previousSelectionRaw);

            if (prev.cardId && prev.cardId !== strCardId) {
              await redis.hDel(gameCardsKey, prev.cardId);
              await GameCard.findOneAndUpdate(
                { gameId: strGameId, cardId: Number(prev.cardId) },
                { isTaken: false, takenBy: null }
              );
              socket.to(strGameId).emit("cardAvailable", { cardId: prev.cardId });
            }
          }

          // 5️⃣ Store new selection in Redis (optional atomic HSETNX style)
          await redis.hSet(gameCardsKey, strCardId, strTelegramId);
          const selectionData = JSON.stringify({
            telegramId: strTelegramId,
            cardId: strCardId,
            card: cleanCard,
            gameId: strGameId,
          });
          getCardsKey();
          await redis.hSet(userSelectionsKey, socket.id, selectionData);
          //await redis.hSet(userSelectionsKey, strTelegramId, selectionData);
          await redis.hSet("userSelectionsByTelegramId", strTelegramId, selectionData);
          //console.log(`Redis hSet: gameCards:${strGameId} [${strCardId}] = ${strTelegramId}`);

          // Add robust logging to confirm storage
          console.log(`DEBUG_CARD_SELECTED_PERSIST: Attempting to HSET 'userSelectionsByTelegramId' for '${strTelegramId}' with:`, selectionData);
          const verificationData = await redis.hGet("userSelectionsByTelegramId", strTelegramId);
          console.log(`DEBUG_CARD_SELECTED_PERSIST: VERIFICATION - Data retrieved immediately:`, verificationData);

          
          //console.log("All userSelections keys:", await redis.hKeys("userSelections"));
          //console.log("Trying userSelection for socket.id:", socket.id);
          //console.log("Trying userSelection for telegramId:", strTelegramId);


          // 6️⃣ Emit
         // io.to(strTelegramId).emit("cardConfirmed", { cardId: strCardId, card: cleanCard });
          socket.emit("cardConfirmed", { cardId: strCardId, card: cleanCard });
          socket.to(strGameId).emit("otherCardSelected", { telegramId: strTelegramId, cardId: strCardId });

          const updatedSelections = await redis.hGetAll(gameCardsKey);
          io.to(strGameId).emit("currentCardSelections", updatedSelections);

          const numberOfPlayers = await redis.sCard(`gameSessions:${strGameId}`);
          io.to(strGameId).emit("gameid", { gameId: strGameId, numberOfPlayers });

          //console.log(`✅ ${strTelegramId} selected card ${strCardId} in game ${strGameId}`);
        } catch (err) {
          console.error("❌ cardSelected error:", err);
          socket.emit("cardError", { message: "Card selection failed." });
        } finally {
          await redis.del(lockKey); // 🔓 Always release lock
        }
      });


      socket.on("unselectCardOnLeave", async ({ gameId, telegramId, cardId }) => {
        console.log("unselectCardOnLeave is called");
        console.log("unslected datas ", gameId, telegramId, cardId );

        try {
          const strCardId = String(cardId);
          const strTelegramId = String(telegramId);

          const currentCardOwner = await redis.hGet(`gameCards:${gameId}`, strCardId);

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
 socket.on("joinGame", async ({ gameId, telegramId }) => {
    console.log("joinGame is invoked 🔥🔥🔥");
    const strGameId = String(gameId);
    const strTelegramId = String(telegramId);

    try {
        // 1. Get the current active session ID for this gameId
        const currentSessionId = await redis.get(`gameSessionId:${strGameId}`);
        console.log(`[joinGame] User ${strTelegramId} trying to join ${strGameId}. Current active session: ${currentSessionId || 'N/A'}`);

        // 2. Get the user's previously stored selection info, including their last known session ID for this game
        const userOverallSelectionRaw = await redis.hGet("userSelectionsByTelegramId", strTelegramId);
        let userPreviousSessionId = null;
        let userSelectionParsed = null;

        if (userOverallSelectionRaw) {
            try {
                userSelectionParsed = JSON.parse(userOverallSelectionRaw);
                // Ensure the selection is for the *same gameId* to avoid mixing contexts
                if (String(userSelectionParsed.gameId) === strGameId) {
                    userPreviousSessionId = userSelectionParsed.sessionId;
                }
            } catch (e) {
                console.error(`❌ Error parsing userSelectionsByTelegramId for ${strTelegramId}: ${e.message}. Clearing corrupted data.`);
                await redis.hDel("userSelectionsByTelegramId", strTelegramId); // Clean up corrupted data
            }
        }
        console.log(`[joinGame] User ${strTelegramId} previous session for ${strGameId}: ${userPreviousSessionId || 'N/A'}`);


        // 3. Conditional Winner History Check
        // Only check for a past winner if:
        //    a) The user had a previous session ID.
        //    b) That previous session ID is DIFFERENT from the current active session ID.
        // This indicates they are joining a new round/game after a previous one concluded.
        if (userPreviousSessionId && userPreviousSessionId !== currentSessionId) {
            const previousWinnerRaw = await redis.get(`gameWinner:${userPreviousSessionId}`);
            if (previousWinnerRaw) {
                try {
                    const winnerInfo = JSON.parse(previousWinnerRaw);
                    console.log(`[joinGame] Found historical winner for previous session ${userPreviousSessionId} for user ${strTelegramId}. Emitting 'winnerConfirmed'.`);
                    socket.emit("winnerConfirmed", winnerInfo);
                    // Crucially: DO NOT return here. The user should still proceed to join the new game/lobby.
                    // The client-side handles displaying the winner and then transitioning.
                } catch (e) {
                    console.error(`❌ Error parsing historical winner payload for previous session ${userPreviousSessionId}: ${e.message}. Marking for cleanup.`);
                    await redis.del(`gameWinner:${userPreviousSessionId}`); // Clear corrupted data
                }
            }
        }

        // 4. Validate user registration for the *current* game state via MongoDB
        const game = await GameControl.findOne({ gameId: strGameId });
        if (!game || !game.players.includes(strTelegramId)) {
            console.warn(`🚫 Blocked user ${strTelegramId} (not registered/paid) from joining game ${strGameId}.`);
            socket.emit("joinError", { message: "You are not registered in this game or game is not active." });
            return;
        }

        // 5. Update user's current session in userSelectionsByTelegramId
        // This is critical to track what game session the user is currently "in".
        if (currentSessionId) {
            const updatedUserSelection = {
                gameId: strGameId,
                sessionId: currentSessionId,
                // Preserve other user selections if they are stored here (e.g., last selected cardId)
                // If you store cardId here, ensure it's cleared or managed properly for new sessions.
                cardId: userSelectionParsed ? userSelectionParsed.cardId : null, // Example: keep last card if relevant
                // Add other relevant user selections from userSelectionParsed if needed
            };
            await redis.hSet("userSelectionsByTelegramId", strTelegramId, JSON.stringify(updatedUserSelection));
            console.log(`[joinGame] User ${strTelegramId} selection updated to current session ${currentSessionId} for game ${strGameId}.`);
        } else {
            // If there's no currentSessionId, it means the game is not actively running a session yet.
            // This might be a lobby phase or waiting for a new round to start after a full reset.
            // You might want to clear the old sessionId for this game from the user's selection if no current session exists.
            if (userSelectionParsed && String(userSelectionParsed.gameId) === strGameId) {
                userSelectionParsed.sessionId = null; // Clear old session association
                await redis.hSet("userSelectionsByTelegramId", strTelegramId, JSON.stringify(userSelectionParsed));
                console.log(`[joinGame] Cleared old session ID for user ${strTelegramId} as no current session is active for game ${strGameId}.`);
            }
        }


        // 6. Store essential info for disconnect handling for *this specific socket* and phase
        await redis.hSet(`joinGameSocketsInfo`, socket.id, JSON.stringify({
            telegramId: strTelegramId,
            gameId: strGameId,
            phase: 'joinGame',
            sessionId: currentSessionId // Store current sessionId with the socket
        }));
        await redis.set(`activeSocket:${strTelegramId}:${socket.id}`, '1', 'EX', ACTIVE_SOCKET_TTL_SECONDS);
        console.log(`Backend: Socket ${socket.id} for ${strTelegramId} set up in 'joinGame' phase.`);


        // 7. Add player to Redis set for gameRooms (represents overall game presence for this round)
        await redis.sAdd(`gameRooms:${strGameId}`, strTelegramId);
        socket.join(strGameId); // Join the socket.io room

        const playerCount = await redis.sCard(`gameRooms:${strGameId}`);
        io.to(strGameId).emit("playerCountUpdate", {
            gameId: strGameId,
            playerCount,
        });
        console.log(`[joinGame] Player ${strTelegramId} joined game ${strGameId}, total players now: ${playerCount}`);

        // 8. Confirm to the socket the gameId and telegramId, and crucially, the currentSessionId
        socket.emit("gameId", { gameId: strGameId, telegramId: strTelegramId, sessionId: currentSessionId });

        // 9. Retrieve and send previously drawn numbers (only if there's a current session)
        const gameDrawsKey = getGameDrawsKey(strGameId); // Assuming getGameDrawsKey is available
        if (currentSessionId) {
            const drawnNumbersRaw = await redis.lRange(gameDrawsKey, 0, -1); // Get all drawn numbers
            const drawnNumbers = drawnNumbersRaw.map(Number); // Convert them back to numbers if stored as strings

            // Format the drawn numbers with their letters if needed for client display
            const formattedDrawnNumbers = drawnNumbers.map(number => {
                const letterIndex = Math.floor((number - 1) / 15);
                const letter = ["B", "I", "N", "G", "O"][letterIndex];
                return { number, label: `${letter}-${number}` };
            });

            if (formattedDrawnNumbers.length > 0) {
                socket.emit("drawnNumbersHistory", {
                    gameId: strGameId,
                    history: formattedDrawnNumbers
                });
                console.log(`[joinGame] Sent ${formattedDrawnNumbers.length} historical drawn numbers to ${strTelegramId} for game ${strGameId}.`);
            }
        } else {
            console.log(`[joinGame] No current session active, not sending drawn numbers history to ${strTelegramId} for game ${strGameId}.`);
        }

    } catch (err) {
        console.error("❌ Redis error in joinGame:", err);
        socket.emit("joinError", { message: "Failed to join game. Please refresh or retry." });
    }
});



 
socket.on("gameCount", async ({ gameId }) => {
    const strGameId = String(gameId);

    // --- ⭐ CRITICAL CHANGE 1: Acquire Lock and Check State FIRST ⭐ ---
    // Check in-memory state for immediate, low-latency lock.
    if (state.activeDrawLocks[strGameId] || state.countdownIntervals[strGameId] || state.drawIntervals[strGameId] || state.drawStartTimeouts[strGameId]) {
        console.log(`⚠️ Game ${strGameId} already has an active countdown or draw lock in memory. Ignoring gameCount event.`);
        return;
    }

    // Now check Redis for a persistent lock or active game status (cross-instance safety)
    const [redisHasLock, redisIsActive] = await Promise.all([
        redis.get(getActiveDrawLockKey(strGameId)),
        redis.get(getGameActiveKey(strGameId))
    ]);

    if (redisHasLock === "true" || redisIsActive === "true") {
        console.log(`⚠️ Game ${strGameId} is already active or locked in Redis. Ignoring gameCount event.`);
        return;
    }

    // ⭐ CRITICAL CHANGE 2: Set the lock *immediately after passing all checks* ⭐
    state.activeDrawLocks[strGameId] = true; // Set in-memory lock
    await redis.set(getActiveDrawLockKey(strGameId), "true"); // Set Redis lock (with EX/PX if desired for auto-expiry)
    // You might want to set an expiry on this Redis lock if a game could get stuck
    // await redis.set(getActiveDrawLockKey(strGameId), "true", 'EX', 300); // e.g., expires in 5 minutes

    console.log(`🚀 Attempting to start countdown for game ${strGameId}`);

    try {
        // --- 1. CLEANUP essential Redis keys and intervals (now that we've acquired the lock and are ready to proceed) ---
        // This cleanup is valid here, as we're preparing a new countdown.
        await Promise.all([
            redis.del(getGameActiveKey(strGameId)),
            redis.del(getCountdownKey(strGameId)),
            // redis.del(getActiveDrawLockKey(strGameId)), // Do NOT delete the lock we just acquired!
            redis.del(getGameDrawStateKey(strGameId)),
            redis.del(getGameDrawsKey(strGameId)),
        ]);

        // Clear any old in-memory intervals if they somehow survived (redundant but safe)
        if (state.countdownIntervals[strGameId]) {
            clearInterval(state.countdownIntervals[strGameId]);
            delete state.countdownIntervals[strGameId];
        }
        if (state.drawIntervals[strGameId]) {
            clearInterval(state.drawIntervals[strGameId]);
            delete state.drawIntervals[strGameId];
        }
        if (state.drawStartTimeouts[strGameId]) {
            clearTimeout(state.drawStartTimeouts[strGameId]);
            delete state.drawStartTimeouts[strGameId];
        }
        // state.activeDrawLocks[strGameId] is managed by the new logic.

        // 2. Prepare shuffled numbers and save to Redis under gameDrawStateKey
        const numbers = Array.from({ length: 75 }, (_, i) => i + 1).sort(() => Math.random() - 0.5);
        await redis.set(getGameDrawStateKey(strGameId), JSON.stringify({ numbers, index: 0 }));

        // 3. Create or update GameControl in DB
        const existing = await GameControl.findOne({ gameId: strGameId });
        const sessionId = uuidv4();
        state.gameSessionIds[strGameId] = sessionId; // Using state.gameSessionIds to store sessionId
        await redis.set(`gameSessionId:${strGameId}`, sessionId, 'EX', 3600 * 24);
        const stakeAmount = Number(strGameId); // Ideally configurable

        if (!existing) {
            await GameControl.create({
                sessionId,
                gameId: strGameId,
                stakeAmount,
                totalCards: 0,
                prizeAmount: 0,
                isActive: false, // Will become true after countdown
                createdBy: "system",
            });
        } else {
            existing.sessionId = sessionId;
            existing.stakeAmount = stakeAmount;
            existing.totalCards = 0;
            existing.prizeAmount = 0;
            existing.isActive = false; // Will become true after countdown
            existing.createdAt = new Date(); // Update creation time for new session
            await existing.save();
        }

        // 4. Countdown logic via Redis and setInterval
        let countdownValue = 15;
        await redis.set(getCountdownKey(strGameId), countdownValue.toString());

        io.to(strGameId).emit("countdownTick", { countdown: countdownValue }); // Emit initial tick

        state.countdownIntervals[strGameId] = setInterval(async () => {
            if (countdownValue > 0) {
                countdownValue--;
                io.to(strGameId).emit("countdownTick", { countdown: countdownValue });
                await redis.set(getCountdownKey(strGameId), countdownValue.toString());
            } else {
                clearInterval(state.countdownIntervals[strGameId]);
                delete state.countdownIntervals[strGameId];
                await redis.del(getCountdownKey(strGameId));
                console.log(`[gameCount] Countdown ended for game ${strGameId}`);

                const currentPlayersInRoom = (await redis.sCard(getGameRoomsKey(strGameId))) || 0;
                const prizeAmount = stakeAmount * currentPlayersInRoom;

                if (currentPlayersInRoom === 0) {
                    console.log("🛑 No players left in game room after countdown. Stopping game initiation.");
                    io.to(strGameId).emit("gameNotStarted", {
                        gameId: strGameId,
                        message: "Not enough players in game room to start.",
                    });

                    // ⭐ CRITICAL CHANGE 3: Release lock and cleanup on no players ⭐
                    delete state.activeDrawLocks[strGameId]; // Release in-memory lock
                    await redis.del(getActiveDrawLockKey(strGameId)); // Release Redis lock
                    await syncGameIsActive(strGameId, false); // Explicitly mark game inactive
                    await resetRound(strGameId, io, state, redis); // This should now handle gameSessionId cleanup
                    return; // Exit the setInterval callback
                }

                // --- CRITICAL RESET FOR GAME START (SESSION-ONLY RESET) ---
                await clearGameSessions(strGameId, redis, state, io);
                console.log(`🧹 ${getGameSessionsKey(strGameId)} cleared as game started.`);

                console.log(`✅ All GameCards for ${strGameId} marked as taken.`);

                // Update GameControl DB with active game info
                await GameControl.findOneAndUpdate(
                    { gameId: strGameId },
                    {
                        $set: {
                            isActive: true,
                            totalCards: currentPlayersInRoom, // Total cards in play is current players
                            prizeAmount: prizeAmount,
                            createdAt: new Date(), // Re-set createdAt for the active game start
                        },
                    }
                );
                await syncGameIsActive(strGameId, true); // Sync your in-memory/global active state

                console.log(`✅ Game ${strGameId} is now ACTIVE with ${currentPlayersInRoom} players.`);

                // Mark game as active in Redis again (to be safe and consistent)
                await redis.set(getGameActiveKey(strGameId), "true");
                state.gameIsActive[strGameId] = true;
                state.gameReadyToStart[strGameId] = true; // Indicate game is ready to start drawin

                io.to(strGameId).emit("cardsReset", { gameId: strGameId }); // Inform clients cards are locked/reset
                io.to(strGameId).emit("gameStart", { gameId: strGameId }); // Signal clients the game has officially started

                // Start drawing numbers if not already running
                if (!state.drawIntervals[strGameId]) {
                    // ⭐ CRITICAL CHANGE 4: Ensure startDrawing also uses the same lock mechanism ⭐
                    // The startDrawing function also needs to check `state.activeDrawLocks`
                    // and potentially acquire its own lock if it's a separate phase
                    await startDrawing(strGameId, io, state, redis); // Pass state and redis if needed
                }
            }
        }, 1000);
    } catch (err) {
        console.error(`❌ Error in gameCount setup for ${gameId}:`, err.message);

        // --- ⭐ CRITICAL CHANGE 5: Release lock and cleanup on error ⭐
        delete state.activeDrawLocks[strGameId]; // Release in-memory lock
        await redis.del(getActiveDrawLockKey(strGameId)); // Release Redis lock
        await syncGameIsActive(strGameId, false); // Mark game inactive on error

        // Ensure cleanup on error for initial setup keys
        delete state.gameDraws[strGameId];
        delete state.countdownIntervals[strGameId];
        delete state.gameSessionIds[strGameId]; // ADD THIS: Clear in-memory gameSessionId on error
        await redis.del(`gameSessionId:${strGameId}`); // ADD THIS: Clear Redis gameSessionId on error

        await Promise.all([
            redis.del(getGameDrawsKey(strGameId)),
            redis.del(getCountdownKey(strGameId)),
            redis.del(getGameActiveKey(strGameId)),
            redis.del(getGameDrawStateKey(strGameId)),
        ]);
        io.to(strGameId).emit("gameNotStarted", { gameId: strGameId, message: "Error during game setup. Please try again." });
    }
});




  async function startDrawing(gameId, io, state, redis) { // Ensure state and redis are passed
    const strGameId = String(gameId); // Ensure gameId is always a string for Redis keys
    const gameDrawStateKey = getGameDrawStateKey(strGameId);
    const gameDrawsKey = getGameDrawsKey(strGameId);
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

                await resetRound(strGameId, io, state, redis); // This call now handles all necessary cleanup.

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

                await resetRound(strGameId, io, state, redis); // This call now handles all necessary cleanup.

                io.to(strGameId).emit("gameEnded", { gameId: strGameId, message: "All numbers drawn, game ended." });
                return;
            }

            // Draw the next number
            const number = gameData.numbers[gameData.index];
            gameData.index += 1;

            // Save updated game state back to Redis
            await redis.set(gameDrawStateKey, JSON.stringify(gameData));

            // Add the drawn number to the Redis list
            await redis.rPush(gameDrawsKey, number.toString());

            // Format the number label (e.g. "B-12")
            const letterIndex = Math.floor((number - 1) / 15);
            const letter = ["B", "I", "N", "G", "O"][letterIndex];
            const label = `${letter}-${number}`;

            console.log(`🔢 Drawing number: ${label}, Index: ${gameData.index - 1}`);

            io.to(strGameId).emit("numberDrawn", { number, label, gameId: strGameId });

        } catch (error) {
            console.error(`❌ Error during drawing interval for game ${strGameId}:`, error);
            clearInterval(state.drawIntervals[strGameId]);
            delete state.drawIntervals[strGameId];
            // Potentially call resetRound or resetGame here on critical error,
            // depending on how severe the error is and if it makes the game unrecoverable.
            // A comprehensive reset (like resetRound) might be appropriate here too.
            await resetRound(strGameId, io, state, redis); // Added for robust error handling
            io.to(strGameId).emit("gameEnded", { gameId: strGameId, message: "Game ended due to drawing error." });
        }
    }, 3000); // Draw every 3 seconds
}




    //check winner

    socket.on("checkWinner", async ({ telegramId, gameId, cartelaId, selectedNumbers}) => {
      const selectedSet = new Set((selectedNumbers || []).map(Number));


      try {

        // Validate cartelaId
        const numericCardId = Number(cartelaId);
        if (isNaN(numericCardId)) {
          socket.emit("winnerError", { message: "Invalid or missing card ID." });
          console.error("❌ checkWinner: cartelaId is NaN or invalid:", cartelaId);
          return;
        }

        // 1. Get drawn numbers as list from Redis
        const drawnNumbersRaw = await redis.lRange(`gameDraws:${gameId}`, 0, -1);
        if (!drawnNumbersRaw || drawnNumbersRaw.length === 0) {
          socket.emit("winnerError", { message: "No numbers have been drawn yet." });
          return;
        }
        const drawnNumbers = new Set(drawnNumbersRaw.map(Number));

        // 2. Fetch the official card from DB
        const cardData = await GameCard.findOne({ gameId, cardId: Number(cartelaId) });
        if (!cardData) {
          socket.emit("winnerError", { message: "Card not found." });
          return;
        }

        console.log("✅ drawnNumbers:", drawnNumbers);
        console.log("✅ selectedNumbers (marked):", selectedSet);
        console.log("✅ cardData.card:", cardData.card);

        // 3. Backend pattern check function - implement this based on your rules
      const pattern = checkBingoPattern(cardData.card, drawnNumbers, selectedSet);
      const isWinner = pattern.some(Boolean); // ✅ Check if any cell is true

    if (!isWinner) {
      socket.emit("winnerError", { message: "No winning pattern found." });
      return;
    }


        // 4. If winner confirmed, call internal winner processing function
        await processWinner({ telegramId, gameId, cartelaId, io, selectedSet, state, redis });


        //socket.emit("winnerConfirmed", { message: "Winner verified and processed!" });

      } catch (error) {
        console.error("Error in checkWinner:", error);
        socket.emit("winnerError", { message: "Internal error verifying winner." });
      }
    });






  async function processWinner({ telegramId, gameId, cartelaId, io, selectedSet, state, redis }) {
    console.log("process winner", cartelaId);
    try {
        const strGameId = String(gameId); // Ensure gameId is string for consistency

        // This is CRITICAL: Retrieve the current active sessionId
        const sessionId = await redis.get(`gameSessionId:${strGameId}`);
        if (!sessionId) {
            console.error(`❌ Error: No session ID found for gameId ${strGameId} during winner processing. Cannot store session-specific winner info.`);
            // Depending on your error handling strategy, you might choose to throw,
            // or proceed without storing session-specific winner, but this indicates a setup issue.
            // For now, we'll proceed but log a severe warning and won't store `gameWinner:${sessionId}`
            // which could lead to issues for disconnected players.
            // Consider this a MUST-FIX if it happens in production.
            // For the purpose of this code, if sessionId is null, we can't use it for `gameWinner:`.
            // Let's make it a throw to ensure it's addressed if it ever happens.
            throw new Error(`No session ID found for gameId ${strGameId}. Cannot process winner correctly.`);
        }


        const gameData = await GameControl.findOne({ gameId: strGameId });
        if (!gameData) throw new Error(`GameControl data not found for gameId ${strGameId}`);

        const prizeAmount = gameData.prizeAmount;
        const stakeAmount = gameData.stakeAmount;
        const playerCount = gameData.totalCards; // This typically refers to total cards in the game, not active players.

        if (typeof prizeAmount !== "number" || isNaN(prizeAmount)) {
            throw new Error(`Invalid or missing prizeAmount (${prizeAmount}) for gameId: ${strGameId}`);
        }

        const winnerUser = await User.findOne({ telegramId });
        if (!winnerUser) throw new Error(`User with telegramId ${telegramId} not found`);

        winnerUser.balance = Number(winnerUser.balance || 0) + prizeAmount;
        await winnerUser.save();

        await redis.set(`userBalance:${telegramId}`, winnerUser.balance.toString());

        const selectedCard = await GameCard.findOne({ gameId: strGameId, cardId: cartelaId });
        const board = selectedCard?.card || [];

        const drawn = await redis.lRange(`gameDraws:${strGameId}`, 0, -1);
        const drawnNumbers = new Set(drawn.map(Number));

        const winnerPattern = checkBingoPattern(board, drawnNumbers, selectedSet);


        // --- KEY CHANGE HERE: Use sessionId in the Redis key for winner info ---
        const winnerInfo = {
            winnerName: winnerUser.username || "Unknown",
            prizeAmount,
            playerCount, // This might be the count at the time of win, not current live count
            boardNumber: cartelaId,
            board,
            winnerPattern,
            telegramId: telegramId, // Keep as its original type
            gameId: strGameId, // Ensure it's the string version
            sessionId: sessionId, // Explicitly include sessionId in the stored info
            timestamp: Date.now(),
        };

        // Store for a short period, e.g., 5 minutes (300 seconds) using the SESSION ID
        await redis.set(`gameWinner:${sessionId}`, JSON.stringify(winnerInfo), 'EX', 300);
        console.log(`🏆 Stored winner info for session ${sessionId} (game ${strGameId}) in Redis.`);
        // --- END KEY CHANGE ---


        // Emit to current connected clients in the game room
        // Ensure you emit the full `winnerInfo` object which now includes `sessionId`
        io.to(strGameId).emit("winnerConfirmed", winnerInfo);
        // Previously, you were constructing a new object here. It's better to reuse `winnerInfo`.


        await GameHistory.create({
            sessionId,
            gameId: strGameId, // Use strGameId for consistency
            username: winnerUser.username || "Unknown",
            telegramId,
            eventType: "win",
            winAmount: prizeAmount,
            stake: stakeAmount,
            createdAt: new Date(),
        });

        // Log loses for others
        const players = await redis.sMembers(`gameRooms:${strGameId}`) || []; // Use strGameId
        for (const playerTelegramId of players) {
            if (playerTelegramId !== telegramId) {
                const playerUser = await User.findOne({ telegramId: playerTelegramId });
                if (!playerUser) continue;

                await GameHistory.create({
                    sessionId,
                    gameId: strGameId, // Use strGameId
                    username: playerUser.username || "Unknown",
                    telegramId: playerTelegramId,
                    eventType: "lose",
                    winAmount: 0,
                    stake: stakeAmount,
                    createdAt: new Date(),
                });
            }
        }

        await GameControl.findOneAndUpdate({ gameId: strGameId }, { isActive: false }); // Use strGameId
        await syncGameIsActive(strGameId, false); // Use strGameId

        await Promise.all([
            redis.del(`gameRooms:${strGameId}`),
            redis.del(`gameCards:${strGameId}`),
            redis.del(`gameDraws:${strGameId}`),
            redis.del(`gameActive:${strGameId}`),
            redis.del(`countdown:${strGameId}`),
            redis.del(`activeDrawLock:${strGameId}`),
            redis.del(`gameDrawState:${strGameId}`),
            redis.del(`gameSessionId:${strGameId}`), // This key is being deleted, which is correct after we've used its value.
        ]);

        await GameCard.updateMany({ gameId: strGameId }, { isTaken: false, takenBy: null }); // Use strGameId

        // This `resetRound` function *must* generate and set a NEW `gameSessionId:${strGameId}`
        // for the next round to ensure proper session tracking.
        await resetRound(strGameId, io, state, redis);
        io.to(strGameId).emit("gameEnded"); // Use strGameId

    } catch (error) {
        console.error("🔥 Error processing winner:", error);
        // You can emit an error to the user if you want here
    }
}



    // ✅ Handle playerLeave event
    socket.on("playerLeave", async ({ gameId, telegramId }, callback) => {
      const strTelegramId = String(telegramId);
        console.log("outside if inside playerLeave");

      
      try {
         console.log("inside if inside playerLeave");
        console.log(`🚪 Player ${telegramId} is leaving game ${gameId}`);

        // Remove from Redis sets
        await Promise.all([
          redis.sRem(`gameSessions:${gameId}`, telegramId),
          redis.sRem(`gameRooms:${gameId}`, telegramId),
        ]);

        
      console.log(`Looking for userSelections with socket.id=${socket.id} or telegramId=${strTelegramId}`);
      
     let userSelectionRaw = await redis.hGet("userSelectionsByTelegramId", strTelegramId);
        
      console.log("userSelectionRaw:", userSelectionRaw);


        let userSelection = userSelectionRaw ? JSON.parse(userSelectionRaw) : null;
        console.log("cardId in userSelection:", userSelection?.cardId);


        // Free selected card if owned by this player
        if (userSelection?.cardId) {
          console.log("Looking for card owner in Redis with key:", `gameCards:${gameId}`, "and field:", String(userSelection.cardId));
          const cardOwner = await redis.hGet(`gameCards:${gameId}`, String(userSelection.cardId));
          console.log("cardOwner found:", cardOwner);


          console.log("card ownerrrr", cardOwner);
          if (cardOwner === strTelegramId) {
           
            // Free card in DB
           const dbUpdateResult = await GameCard.findOneAndUpdate(
              { gameId, cardId: Number(userSelection.cardId) },
              { isTaken: false, takenBy: null }
            );

            if (dbUpdateResult) {
              console.log(`✅ DB updated: Card ${userSelection.cardId} released for ${telegramId}`);
            } else {
              console.warn(`⚠️ DB update failed: Could not find card ${userSelection.cardId} to release`);
            }

            // ⭐⭐ CRITICAL DEBUG STEP: List all sockets in the target room RIGHT NOW
              const socketsInTargetRoom = await io.in(gameId).allSockets();
              console.log(`Backend: Sockets currently in room '${gameId}' BEFORE emitting 'cardAvailable': ${socketsInTargetRoom.size} sockets.`);
              if (socketsInTargetRoom.size > 0) {
                  socketsInTargetRoom.forEach(sId => console.log(`  - Active socket in room '${gameId}': ${sId}`));
              } else {
                  console.log(`  - Room '${gameId}' appears to be EMPTY.`);
              }

            io.to(gameId).emit("cardAvailable", { cardId: userSelection.cardId });
            console.log("cardAvailable emitedd🔥🔥🔥", userSelection.cardId)

             // Free card in Redis
            await redis.hDel(`gameCards:${gameId}`, userSelection.cardId);
          }
        }

        // Remove userSelections entries by both socket.id and telegramId after usage
     // Remove userSelections entries by both socket.id and telegramId
          await Promise.all([
            redis.hDel("userSelections", socket.id),
            redis.hDel("userSelections", strTelegramId),
           // redis.hDel("userSelectionsByTelegramId", strTelegramId), // ✅ Add this
            redis.del(`activeSocket:${strTelegramId}:${socket.id}`), // ✅ Optional clean-up
          ]);



        // Emit updated player count
        const playerCount = await redis.sCard(`gameRooms:${gameId}`) || 0;
        io.to(gameId).emit("playerCountUpdate", { gameId, playerCount });

        const numberOfPlayers = await redis.sCard(`gameSessions:${gameId}`) || 0;
        io.to(gameId).emit("gameid", { gameId, numberOfPlayers });

        await checkAndResetIfEmpty(gameId, io, redis, state);

        if (callback) callback();
      } catch (error) {
        console.error("❌ Error handling playerLeave:", error);
        if (callback) callback();
      }
    });






// Handle disconnection events
// --- REFACTORED: socket.on("disconnect") ---
    socket.on("disconnect", async (reason) => {
        console.log(`🔴 Client disconnected: ${socket.id}, Reason: ${reason}`);

        let userPayload = null;
        let disconnectedPhase = null;

        // 1. Try to retrieve info from 'lobby' phase (userSelections)
        const userSelectionPayloadRaw = await redis.hGet("userSelections", socket.id);
        if (userSelectionPayloadRaw) {
            try {
                userPayload = JSON.parse(userSelectionPayloadRaw);
                disconnectedPhase = userPayload.phase || 'lobby'; // Default to 'lobby' if phase not explicitly set
            } catch (e) {
                console.error(`❌ Error parsing userSelections payload for ${socket.id}: ${e.message}`);
                await redis.hDel("userSelections", socket.id); // Clean up corrupted data
            }
        }

        // 2. If not found in 'lobby', try to retrieve info from 'joinGame' phase (joinGameSocketsInfo)
        if (!userPayload) {
            const joinGamePayloadRaw = await redis.hGet("joinGameSocketsInfo", socket.id);
            if (joinGamePayloadRaw) {
                try {
                    userPayload = JSON.parse(joinGamePayloadRaw);
                    disconnectedPhase = userPayload.phase || 'joinGame'; // Default to 'joinGame'
                } catch (e) {
                    console.error(`❌ Error parsing joinGameSocketsInfo payload for ${socket.id}: ${e.message}`);
                    await redis.hDel("joinGameSocketsInfo", socket.id); // Clean up corrupted data
                }
            }
        }

        if (!userPayload) {
            console.log("❌ No relevant user session info found for this disconnected socket ID. Skipping full disconnect cleanup.");
            return;
        }

        const { telegramId, gameId } = userPayload;
        const strGameId = String(gameId);
        const strTelegramId = String(telegramId);

        console.log(`[DISCONNECT DEBUG] Processing disconnect for User: ${strTelegramId}, Game: ${strGameId}, Socket: ${socket.id}, Phase: ${disconnectedPhase}`);

        // --- Initial cleanup for the specific disconnected socket based on its phase ---
        await Promise.all([
            redis.del(`activeSocket:${strTelegramId}:${socket.id}`), // Delete the specific active socket TTL key
            redis.hDel("userSelections", socket.id), // Attempt to delete from userSelections (safe if not present)
            redis.hDel("joinGameSocketsInfo", socket.id), // Attempt to delete from joinGameSocketsInfo (safe if not present)
        ]);
        console.log(`🧹 Cleaned up temporary records for disconnected socket ${socket.id}.`);

        // --- Determine remaining active sockets for this user in THIS specific game ---
        const allActiveSocketKeysForUser = await redis.keys(`activeSocket:${strTelegramId}:*`);
        let remainingSocketsForThisGameCount = 0;
        let currentActiveSocketsInfo = []; // To hold parsed info of other active sockets

        const multiGetCommands = redis.multi();
        const otherSocketIds = [];

        for (const key of allActiveSocketKeysForUser) {
            const otherSocketId = key.split(':').pop();
            if (otherSocketId === socket.id) continue; // Skip the currently disconnected socket

            otherSocketIds.push(otherSocketId);
            multiGetCommands.hGet("userSelections", otherSocketId); // Try lobby info
            multiGetCommands.hGet("joinGameSocketsInfo", otherSocketId); // Try joinGame info
        }

        // Execute all batched commands to get info for other sockets
        const otherSocketPayloadsRaw = await multiGetCommands.exec();

        let staleKeysToDelete = [];
        for (let i = 0; i < otherSocketIds.length; i++) {
            const otherSocketId = otherSocketIds[i];
            const userSelectionResult = otherSocketPayloadsRaw[i * 2]; // Result for userSelections hGet
            const joinGameResult = otherSocketPayloadsRaw[i * 2 + 1]; // Result for joinGameSocketsInfo hGet

            let otherSocketInfo = null;
            let otherSocketPhase = null;

            if (userSelectionResult && userSelectionResult[0] === null && userSelectionResult[1]) {
                try {
                    otherSocketInfo = JSON.parse(userSelectionResult[1]);
                    otherSocketPhase = otherSocketInfo.phase || 'lobby';
                } catch (e) {
                    console.error(`❌ Error parsing userSelections payload for other socket ${otherSocketId}: ${e.message}. Marking for cleanup.`);
                    await redis.hDel("userSelections", otherSocketId);
                    staleKeysToDelete.push(`activeSocket:${strTelegramId}:${otherSocketId}`);
                }
            } else if (joinGameResult && joinGameResult[0] === null && joinGameResult[1]) {
                try {
                    otherSocketInfo = JSON.parse(joinGameResult[1]);
                    otherSocketPhase = otherSocketInfo.phase || 'joinGame';
                } catch (e) {
                    console.error(`❌ Error parsing joinGameSocketsInfo payload for other socket ${otherSocketId}: ${e.message}. Marking for cleanup.`);
                    await redis.hDel("joinGameSocketsInfo", otherSocketId);
                    staleKeysToDelete.push(`activeSocket:${strTelegramId}:${otherSocketId}`);
                }
            } else {
                // No valid payload found for this activeSocket key
                console.log(`ℹ️ Found stale activeSocket key activeSocket:${strTelegramId}:${otherSocketId} without a corresponding userSelections or joinGameSocketsInfo entry. Marking for deletion.`);
                staleKeysToDelete.push(`activeSocket:${strTelegramId}:${otherSocketId}`);
            }

            if (otherSocketInfo && String(otherSocketInfo.gameId) === strGameId) {
                remainingSocketsForThisGameCount++;
                currentActiveSocketsInfo.push(otherSocketInfo); // Store info about the remaining sockets
            }
        }

        if (staleKeysToDelete.length > 0) {
            await redis.del(...staleKeysToDelete);
            console.log(`🧹 Cleaned up ${staleKeysToDelete.length} stale activeSocket keys.`);
        }

        console.log(`[DISCONNECT DEBUG] Remaining active sockets for ${strTelegramId} in game ${strGameId}: ${remainingSocketsForThisGameCount}`);

        // --- Unified Grace Period Management based on whether this was the last socket ---
        const timeoutKey = `${strTelegramId}:${strGameId}`;

        // Always clear any *existing* pending timeout for this user/game to prevent race conditions
        if (pendingDisconnectTimeouts.has(timeoutKey)) {
            clearTimeout(pendingDisconnectTimeouts.get(timeoutKey));
            pendingDisconnectTimeouts.delete(timeoutKey);
            console.log(`🕒 Cleared existing pending disconnect timeout for ${timeoutKey}.`);
        }

        // Helper function to handle grace period and cleanup
        const determineGracePeriodAndCleanup = async (disconnectingPhase, remainingActiveSocketsCount) => {
            let gracePeriodDuration = 0;
            let cleanupFunction = null;

            if (disconnectingPhase === 'lobby') {
                gracePeriodDuration = ACTIVE_DISCONNECT_GRACE_PERIOD_MS;
                cleanupFunction = async () => {
                    console.log(`⏱️ Lobby grace period expired for User: ${strTelegramId}, Game: ${strGameId}. Performing lobby-specific cleanup.`);
                    // Release card if held and owned by this user
                    const userOverallSelectionRaw = await redis.hGet("userSelectionsByTelegramId", strTelegramId);
                    if (userOverallSelectionRaw) {
                        const { cardId: userHeldCardId, gameId: selectedGameId } = JSON.parse(userOverallSelectionRaw);
                        if (String(selectedGameId) === strGameId && userHeldCardId) {
                            const gameCardsKey = `gameCards:${strGameId}`;
                            const cardOwner = await redis.hGet(gameCardsKey, String(userHeldCardId));
                            if (cardOwner === strTelegramId) {
                                await redis.hDel(gameCardsKey, String(userHeldCardId));
                                await GameCard.findOneAndUpdate(
                                    { gameId: strGameId, cardId: Number(userHeldCardId) },
                                    { isTaken: false, takenBy: null }
                                );
                                io.to(strGameId).emit("cardReleased", { cardId: Number(userHeldCardId), telegramId: strTelegramId });
                                console.log(`✅ Card ${userHeldCardId} released for ${strTelegramId} due to grace period expiry from game ${strGameId}.`);
                            }
                        }
                    }

                    // Remove the user from ALL relevant unique player sets for this game (lobby and overall game players).
                    const sessionKey = `gameSessions:${strGameId}`;
                    await Promise.all([
                        redis.sRem(sessionKey, strTelegramId),
                        redis.sRem(`gamePlayers:${strGameId}`, strTelegramId), // Remove from overall game players
                        redis.hDel("userSelectionsByTelegramId", strTelegramId), // Clean up overall persisted selection
                    ]);
                    console.log(`👤 ${strTelegramId} removed from lobby sets and overall selection cleaned up after grace period expiry for game ${strGameId}.`);

                    // Recalculate and Broadcast the unique player count for the game (lobby count)
                    const numberOfPlayersLobby = await redis.sCard(sessionKey) || 0;
                    io.to(strGameId).emit("gameid", {
                        gameId: strGameId,
                        numberOfPlayers: numberOfPlayersLobby,
                    });
                    console.log(`📊 Broadcasted counts for game ${strGameId}: Lobby Players = ${numberOfPlayersLobby} after grace period cleanup.`);

                    // Check for full game reset if game is now empty of all unique players
                    const totalPlayersGamePlayers = await redis.sCard(`gamePlayers:${strGameId}`);
                    if (numberOfPlayersLobby === 0 && totalPlayersGamePlayers === 0) {
                        console.log(`🧹 Game ${strGameId} empty after lobby phase grace period. Triggering full game reset.`);
                        await GameControl.findOneAndUpdate(
                            { gameId: strGameId },
                            { isActive: false, totalCards: 0, prizeAmount: 0, players: [], endedAt: new Date() }
                        );
                        await syncGameIsActive(strGameId, false);
                        resetGame(strGameId, io, state, redis);
                        console.log(`Game ${strGameId} has been fully reset.`);
                    }
                };
            } else if (disconnectingPhase === 'joinGame') {
                gracePeriodDuration = JOIN_GAME_GRACE_PERIOD_MS;
                cleanupFunction = async () => {
                    console.log(`⏱️ JoinGame grace period expired for User: ${strTelegramId}, Game: ${strGameId}. Performing joinGame-specific cleanup.`);
                    console.log("🎯🎯🎯🎯 this for the game page 🎯🎯🎯🎯")

                    // For joinGame phase, primary removal is from gameRooms
                    await redis.sRem(`gameRooms:${strGameId}`, strTelegramId);
                    console.log(`👤 ${strTelegramId} removed from gameRooms after joinGame grace period expiry for game ${strGameId}.`);

                    const playerCount = await redis.sCard(`gameRooms:${strGameId}`);
                    io.to(strGameId).emit("playerCountUpdate", { gameId: strGameId, playerCount });
                    console.log(`📊 Broadcasted counts for game ${strGameId}: Total Players = ${playerCount} after joinGame grace period cleanup.`);

                    // Check if the game is completely empty across ALL player sets after this cleanup
                    const totalPlayersGamePlayers = await redis.sCard(`gamePlayers:${strGameId}`);
                    console.log("🚀🔥🚀🔥 total players", totalPlayersGamePlayers);
                    const numberOfPlayersLobby = await redis.sCard(`gameSessions:${strGameId}`) || 0; // Check lobby too
                    if (playerCount === 0 && numberOfPlayersLobby === 0 && totalPlayersGamePlayers === 0) {
                        console.log(`🧹 Game ${strGameId} empty after joinGame phase grace period. Triggering full game reset.`);
                        await GameControl.findOneAndUpdate(
                            { gameId: strGameId },
                            { isActive: false, totalCards: 0, prizeAmount: 0, players: [], endedAt: new Date() }
                        );
                        await syncGameIsActive(strGameId, false);
                        resetGame(strGameId, io, state, redis);
                        console.log(`Game ${strGameId} has been fully reset.`);
                    }
                };
            }

            if (remainingActiveSocketsCount === 0) {
                // This was the user's last active socket for THIS GAME.
                // Start a timer for the full cleanup.
                const timeoutId = setTimeout(async () => {
                    try {
                        await cleanupFunction();
                    } catch (e) {
                        console.error(`❌ Error during grace period cleanup for ${timeoutKey}:`, e);
                    } finally {
                        pendingDisconnectTimeouts.delete(timeoutKey); // Clean up the timeout from the map
                    }
                }, gracePeriodDuration);

                pendingDisconnectTimeouts.set(timeoutKey, timeoutId);
                console.log(`🕒 User ${strTelegramId} has no remaining active sockets for game ${strGameId}. Starting ${gracePeriodDuration / 1000}-second grace period timer for '${disconnectingPhase}' phase.`);
            } else {
                // User still has other active sockets for this game. No full cleanup timer needed.
                console.log(`ℹ️ ${strTelegramId} disconnected from '${disconnectingPhase}' phase via socket (${socket.id}) but still has ${remainingActiveSocketsCount} other active sockets in game ${strGameId}. No grace period timer started.`);

                // Still broadcast updated player counts relevant to the specific phase for immediate UI updates
                if (disconnectingPhase === 'lobby') {
                    const sessionKey = `gameSessions:${strGameId}`;
                    const numberOfPlayersLobby = await redis.sCard(sessionKey) || 0;
                    io.to(strGameId).emit("gameid", {
                        gameId: strGameId,
                        numberOfPlayers: numberOfPlayersLobby,
                    });
                    console.log(`📊 Broadcasted counts for game ${strGameId}: Lobby Players = ${numberOfPlayersLobby} after partial disconnect.`);
                } else if (disconnectingPhase === 'joinGame') {
                    const playerCount = await redis.sCard(`gameRooms:${strGameId}`);
                    io.to(strGameId).emit("playerCountUpdate", { gameId: strGameId, playerCount });
                    console.log(`📊 Broadcasted counts for game ${strGameId}: Total Players = ${playerCount} after partial disconnect.`);
                }

                // A partial disconnect *could* still lead to an empty game if, for instance,
                // the remaining sockets are for a different user, or the last user just left a phase.
                const totalPlayersGamePlayers = await redis.sCard(`gamePlayers:${strGameId}`);
                const numberOfPlayersLobby = await redis.sCard(`gameSessions:${strGameId}`) || 0;
                const playerCountGameRooms = await redis.sCard(`gameRooms:${strGameId}`) || 0;

                if (totalPlayersGamePlayers === 0 && numberOfPlayersLobby === 0 && playerCountGameRooms === 0) {
                    console.log(`🧹 No unique players left in game ${strGameId} across all phases after partial disconnect. Triggering full game reset.`);
                    await GameControl.findOneAndUpdate(
                        { gameId: strGameId },
                        { isActive: false, totalCards: 0, prizeAmount: 0, players: [], endedAt: new Date() }
                    );
                    await syncGameIsActive(strGameId, false);
                    resetGame(strGameId, io, state, redis);
                    console.log(`Game ${strGameId} has been fully reset after partial disconnect.`);
                }
            }
        };

        // Call the helper function to manage grace period and cleanup
        await determineGracePeriodAndCleanup(disconnectedPhase, remainingSocketsForThisGameCount);
    });
  });
};
