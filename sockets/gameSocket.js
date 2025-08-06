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
  socket.on("joinGame", async ({ gameId, GameSessionId, telegramId }) => { // 🟢 Accept GameSessionId
    console.log("joinGame is invoked 🔥🔥🔥");
    try {
        const strGameId = String(gameId);
        const strGameSessionId = String(GameSessionId); // 🟢 Capture as a string
        const strTelegramId = String(telegramId);

        // Validate user is registered in the game via MongoDB
        // 🟢 Use GameSessionId to find the specific game round
        const game = await GameControl.findOne({ GameSessionId: strGameSessionId });
        
        if (!game || !game.players.includes(strTelegramId)) {
            console.warn(`🚫 Blocked user ${strTelegramId} from joining game session ${strGameSessionId}`);

            // 🧠 Check if the game already ended and has winner info (using the GameSessionId)
            const winnerRaw = await redis.get(`winnerInfo:${strGameSessionId}`); // 🟢 Use GameSessionId for Redis key
            if (winnerRaw) {
                const winnerInfo = JSON.parse(winnerRaw);
                console.log(`[Reconnected] Emitting winnerConfirmed to ${strTelegramId} for session ${strGameSessionId}`);
                socket.emit("winnerConfirmed", winnerInfo);
                return;
            }

            // If no winner info, just send generic error
            socket.emit("joinError", { message: "You are not registered in this game." });
            return;
        }

        // Store essential info for disconnect handling for *this* specific phase and socket
        await redis.hSet(`joinGameSocketsInfo`, socket.id, JSON.stringify({
            telegramId: strTelegramId,
            gameId: strGameId,
            GameSessionId: strGameSessionId, // 🟢 Store GameSessionId in Redis
            phase: 'joinGame'
        }));
        await redis.set(`activeSocket:${strTelegramId}:${socket.id}`, '1', 'EX', ACTIVE_SOCKET_TTL_SECONDS);
        console.log(`Backend: Socket ${socket.id} for ${strTelegramId} set up in 'joinGame' phase.`);


        // Add player to Redis set for gameRooms (represents overall game presence)
        // We can still use gameId for the main room since players of a specific GameId type
        // will join that room regardless of the session.
        await redis.sAdd(`gameRooms:${strGameId}`, strTelegramId);
        socket.join(strGameId); // Join the socket.io room

        const playerCount = await redis.sCard(`gameRooms:${strGameId}`);
        io.to(strGameId).emit("playerCountUpdate", {
            gameId: strGameId,
            playerCount,
        });
        console.log(`[joinGame] Player ${strTelegramId} joined game ${strGameId}, total players now: ${playerCount}`);

        // Confirm to the socket the gameId and telegramId
        socket.emit("gameId", { 
            gameId: strGameId, 
            GameSessionId: strGameSessionId, // 🟢 Emit the session ID back to the client
            telegramId: strTelegramId 
        });

        // --- NEW LOGIC: Retrieve and send previously drawn numbers ---
        // 🟢 Use a key that includes the GameSessionId to be specific to this round
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
                GameSessionId: strGameSessionId, // 🟢 Also send the SessionId in the history
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

    socket.on("gameCount", async ({ gameId, GameSessionId }) => {
        const strGameId = String(gameId);
        const strGameSessionId = String(GameSessionId); // 🟢 Capture the GameSessionId
        let finalPlayerList = []; // Array to store players who successfully paid their stake

        // --- CRITICAL: Acquire Lock and Check State FIRST ---
        // This part remains at the very top to prevent concurrent gameCounts
        if (state.activeDrawLocks[strGameId] || state.countdownIntervals[strGameId] || state.drawIntervals[strGameId] || state.drawStartTimeouts[strGameId]) {
            console.log(`⚠️ Game ${strGameId} already has an active countdown or draw lock in memory. Ignoring gameCount event.`);
            return; // Return without clearing lock, as it wasn't acquired by THIS invocation
        }

        const [redisHasLock, redisIsActive] = await Promise.all([
            redis.get(getActiveDrawLockKey(strGameId)),
            redis.get(getGameActiveKey(strGameId))
        ]);

        if (redisHasLock === "true" || redisIsActive === "true") {
            console.log(`⚠️ Game ${strGameId} is already active or locked in Redis. Ignoring gameCount event.`);
            return; // Return without clearing lock, as it wasn't acquired by THIS invocation
        }

        // --- Acquire the Lock NOW ---
        // This part must execute if the above checks pass
        state.activeDrawLocks[strGameId] = true;
        await redis.set(getActiveDrawLockKey(strGameId), "true");

        console.log(`🚀 Attempting to start countdown for game ${strGameId}`);

        try {
            // --- NEW CHECK: Player count from GameControl BEFORE any extensive setup ---
            // Place it here, *after* you've acquired the lock.
            // If this check fails, you MUST release the lock you just acquired.
             const currentGameControl = await GameControl.findOne({ GameSessionId: strGameSessionId });
            if (!currentGameControl || !Array.isArray(currentGameControl.players) || currentGameControl.players.length < 2) { // Assuming min 2 players to start
                console.log(`🛑 Not enough players in GameControl to start game ${strGameId}. Found: ${currentGameControl?.players.length || 0}`);
                
                // --- Crucial: Release the lock if aborting early ---
                delete state.activeDrawLocks[strGameId];
                await redis.del(getActiveDrawLockKey(strGameId));
                await syncGameIsActive(strGameId, false); // Mark game as inactive in Redis

                // Inform the client that the game is not starting
                io.to(strGameId).emit("gameNotStarted", { gameId: strGameId, message: "Not enough players in GameControl to start the game." });
                return; // Abort the gameCount process
            }
            console.log(`✅ GameControl has ${currentGameControl.players.length} players before full setup for ${strGameId}.`);

            // --- 1. CLEANUP essential Redis keys and intervals ---
            // This part and everything after only executes if the initial player count is sufficient.
            await Promise.all([
                redis.del(getGameActiveKey(strGameId)),
                redis.del(getCountdownKey(strGameId)),
                redis.del(getGameDrawStateKey(strGameId)),
                redis.del(getGameDrawsKey(strGameId)),
            ]);

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

            // 2. Prepare shuffled numbers and save to Redis
            const numbers = Array.from({ length: 75 }, (_, i) => i + 1).sort(() => Math.random() - 0.5);
            await redis.set(getGameDrawStateKey(strGameId), JSON.stringify({ numbers, index: 0 }));

            // 3. Create or update GameControl in DB
            let gameControlDoc = currentGameControl; // Use the already fetched doc
            const sessionId = uuidv4();
            state.gameSessionIds[strGameId] = sessionId;
            await redis.set(`gameSessionId:${strGameId}`, sessionId, 'EX', 3600 * 24);

            const stakeAmount = Number(strGameId);

            // Update existing gameControlDoc properties
            //gameControlDoc.sessionId = sessionId;
            gameControlDoc.stakeAmount = stakeAmount;
            gameControlDoc.totalCards = 0; // Will be updated after deductions
            gameControlDoc.prizeAmount = 0; // Will be updated after deductions
            gameControlDoc.isActive = false; // Still false during countdown
            gameControlDoc.createdAt = new Date();
            await gameControlDoc.save();

            // 4. Countdown logic
            let countdownValue = 15;
            await redis.set(getCountdownKey(strGameId), countdownValue.toString());

            io.to(strGameId).emit("countdownTick", { countdown: countdownValue });

            state.countdownIntervals[strGameId] = setInterval(async () => {
                if (countdownValue > 0) {
                    countdownValue--;
                    io.to(strGameId).emit("countdownTick", { countdown: countdownValue });
                    await redis.set(getCountdownKey(strGameId), countdownValue.toString());
                } else {
                    clearInterval(state.countdownIntervals[strGameId]);
                    delete state.countdownIntervals[strGameId];
                    await redis.del(getCountdownKey(strGameId));

                    // Re-fetch players from GameControl.players for deduction phase
                    const currentPlayersInGameControl = await GameControl.findOne({GameSessionId: strGameSessionId }).select('players -_id');
                    const playersForDeduction = currentPlayersInGameControl ? currentPlayersInGameControl.players.map(String) : [];

                    // This check remains important as players might leave during the countdown
                    if (playersForDeduction.length < 2) {
                        console.log(`🛑 Not enough players (${playersForDeduction.length}) in GameControl to proceed with deductions for ${strGameId}. Aborting.`);
                        io.to(strGameId).emit("gameNotStarted", { gameId: strGameId, message: "Not enough players to start the game." });
                        // No need to refund here, as deductions haven't started.
                        delete state.activeDrawLocks[strGameId];
                        await redis.del(getActiveDrawLockKey(strGameId));
                        await syncGameIsActive(strGameId, false);
                       // await resetRound(strGameId, io, state, redis); // Cleanup game state
                        return;
                    }
                    console.log(`✅ Proceeding with deductions for ${playersForDeduction.length} players from GameControl.players.`);


                    let successfulDeductions = 0;
                    let prizeAmount = 0;
                    let successfullyDeductedPlayers = []; 

                    for (const telegramId of playersForDeduction) {
                        const debugUser = await User.findOne({ telegramId });
                        if (debugUser) {
                            console.log(`[DEBUG] Player ${telegramId} state: balance=${debugUser.balance}, reservedForGameId=${debugUser.reservedForGameId}, expectedGameId=${strGameId}`);
                        } else {
                            console.log(`[DEBUG] Player ${telegramId} not found in database.`);
                        }

                        try {
                            const user = await User.findOneAndUpdate(
                                { telegramId, reservedForGameId: strGameId, balance: { $gte: stakeAmount } },
                                {
                                    $inc: { balance: -stakeAmount },
                                    $unset: { reservedForGameId: "" }
                                },
                                { new: true }
                            );

                            if (user) {
                                successfulDeductions++;
                                finalPlayerList.push(telegramId);
                                successfullyDeductedPlayers.push(telegramId); 
                                console.log(`✅ Balance deducted for player ${telegramId}. Final balance: ${user.balance}.`);
                                await redis.set(`userBalance:${telegramId}`, user.balance.toString(), "EX", 60);
                            } else {
                                console.log(`⚠️ Failed to deduct balance for player ${telegramId}. Removing from game.`);
                                const userAfterUnset = await User.updateOne(
                                    { telegramId },
                                    { $unset: { reservedForGameId: "" } } 
                                );
                                if (userAfterUnset) {
                                    const userDoc = await User.findOne({ telegramId });
                                    if (userDoc) {
                                        await redis.set(`userBalance:${telegramId}`, userDoc.balance.toString(), "EX", 60);
                                    }
                                }
                                await redis.sRem(getGameRoomsKey(strGameId), telegramId);
                                await GameControl.updateOne(
                                    { gameId: strGameId },
                                    { GameSessionId: strGameSessionId },
                                    { $pull: { players: telegramId } }
                                );
                            }
                        } catch (error) {
                            console.error(`❌ Error deducting balance for player ${telegramId}:`, error);
                            await User.updateOne(
                                { telegramId },
                                { $unset: { reservedForGameId: "" } }
                            );
                            const userDoc = await User.findOne({ telegramId });
                            if (userDoc) {
                                await redis.set(`userBalance:${telegramId}`, userDoc.balance.toString(), "EX", 60);
                            }
                        }
                    }
                    
                    prizeAmount = stakeAmount * successfulDeductions;
                    console.log(`✅ Final prize amount calculated: ${prizeAmount} from ${successfulDeductions} players.`);

                    if (successfulDeductions < 2) {
                        console.log("🛑 Not enough players to start the game after deductions. Refunding stakes.");
                        
                        for (const playerId of successfullyDeductedPlayers) {
                            console.log(`💰 Refunding stake for player ${playerId}`);
                            const refundedUser = await User.findOneAndUpdate(
                                { telegramId: playerId },
                                {
                                    $inc: { balance: stakeAmount },
                                    $unset: { reservedForGameId: "" }
                                },
                                { new: true }
                            );

                            if (refundedUser) {
                                console.log(`✅ Refund successful for player ${playerId}. New balance: ${refundedUser.balance}`);
                                await redis.set(`userBalance:${playerId}`, refundedUser.balance.toString(), "EX", 60);
                            } else {
                                console.error(`❌ FATAL: Refund failed for player ${playerId}. User document not found or update failed.`);
                            }
                        }

                        io.to(strGameId).emit("gameNotStarted", {
                            gameId: strGameId,
                            message: "Not enough players in game room to start. Your stake has been refunded.",
                        });

                        delete state.activeDrawLocks[strGameId];
                        await redis.del(getActiveDrawLockKey(strGameId));
                        await syncGameIsActive(strGameId, false);
                        //await resetRound(strGameId, io, state, redis);
                        return;
                    }

                    await GameControl.findOneAndUpdate(
                        { gameId: strGameId },
                        { GameSessionId: strGameSessionId },
                        {
                            $set: {
                                isActive: true,
                                totalCards: successfulDeductions,
                                prizeAmount: prizeAmount,
                                players: finalPlayerList, 
                                createdAt: new Date(),
                            },
                        }
                    );
                    await syncGameIsActive(strGameId, true);

                    console.log(`✅ Game ${strGameId} is now ACTIVE with ${successfulDeductions} players. Prize: ${prizeAmount}`);
                    
                    await clearUserReservations(finalPlayerList);

                    await clearGameSessions(strGameId, redis, state, io);
                    await redis.set(getGameActiveKey(strGameId), "true");
                    state.gameIsActive[strGameId] = true;
                    state.gameReadyToStart[strGameId] = true;
                    
                    io.to(strGameId).emit("cardsReset", { gameId: strGameId });
                    io.to(strGameId).emit("gameStart", { gameId: strGameId });

                    if (!state.drawIntervals[strGameId]) {
                        await startDrawing(strGameId, io, state, redis);
                    }
                }
            }, 1000);
        } catch (err) {
            console.error(`❌ Error in gameCount setup for ${gameId}:`, err.message);

            delete state.activeDrawLocks[strGameId];
            await redis.del(getActiveDrawLockKey(strGameId));
            await syncGameIsActive(strGameId, false);

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

            delete state.gameDraws[strGameSessionId];
            delete state.gameSessionIds[strGameId];
            await redis.del(`gameSessionId:${strGameId}`);

            await Promise.all([
                redis.del(getGameDrawsKey(strGameId)),
                redis.del(getCountdownKey(strGameId)),
                redis.del(getGameActiveKey(strGameId)),
                redis.del(getGameDrawStateKey(strGameId)),
                redis.del(getActiveDrawLockKey(strGameId)), 
            ]);
            io.to(strGameId).emit("gameNotStarted", { gameId: strGameId, message: "Error during game setup. Please try again." });
        }
    });




  async function startDrawing(gameId, GameSessionId, io, state, redis) { // Ensure state and redis are passed
    const strGameId = String(gameId);
    const strGameSessionId = String(GameSessionId); // Ensure gameId is always a string for Redis keys
    const gameDrawStateKey = getGameDrawStateKey(strGameId);
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
        await processWinner({ telegramId, gameId, GameSessionId, cartelaId, io, selectedSet, state, redis });


        //socket.emit("winnerConfirmed", { message: "Winner verified and processed!" });

      } catch (error) {
        console.error("Error in checkWinner:", error);
        socket.emit("winnerError", { message: "Internal error verifying winner." });
      }
    });






    async function processWinner({ telegramId, gameId, GameSessionId, cartelaId, io, selectedSet, state, redis }) {
    
     const strGameSessionId = String(GameSessionId);

      console.log("process winner", cartelaId  );
      try {
        const sessionId = await redis.get(`gameSessionId:${gameId}`);
        if (!sessionId) throw new Error(`No session ID found for gameId ${gameId}`);

        const gameData = await GameControl.findOne({ GameSessionId: strGameSessionId });
        if (!gameData) throw new Error(`GameControl data not found for gameId ${gameId}`);

        const prizeAmount = gameData.prizeAmount;
        const stakeAmount = gameData.stakeAmount;
        const playerCount = gameData.totalCards;

        if (typeof prizeAmount !== "number" || isNaN(prizeAmount)) {
          throw new Error(`Invalid or missing prizeAmount (${prizeAmount}) for gameId: ${gameId}`);
        }

        const winnerUser = await User.findOne({ telegramId });
        if (!winnerUser) throw new Error(`User with telegramId ${telegramId} not found`);

        winnerUser.balance = Number(winnerUser.balance || 0) + prizeAmount;
        await winnerUser.save();

        await redis.set(`userBalance:${telegramId}`, winnerUser.balance.toString());

        const selectedCard = await GameCard.findOne({ gameId, cardId: cartelaId });
        const board = selectedCard?.card || [];

        // ✅ Add this block
         const drawn = await redis.lRange(`gameDraws:${strGameSessionId}`, 0, -1);
        const drawnNumbers = new Set(drawn.map(Number));

        // ✅ Call pattern checker
        const winnerPattern = checkBingoPattern(board, drawnNumbers, selectedSet);



        io.to(gameId.toString()).emit("winnerConfirmed", {
          winnerName: winnerUser.username || "Unknown",
          prizeAmount,
          playerCount,
          boardNumber: cartelaId,
          board, // ✅ Include board here
          winnerPattern,
          telegramId,
          gameId,
           GameSessionId: strGameSessionId, // 🟢 Include the session ID in the emit
        });

        await GameHistory.create({
          sessionId: strGameSessionId,
          gameId: gameId.toString(),
          username: winnerUser.username || "Unknown",
          telegramId,
          eventType: "win",
          winAmount: prizeAmount,
          stake: stakeAmount,
          createdAt: new Date(),
        });


        // Log loses for otherss
        const players = await redis.sMembers(`gameRooms:${gameId}`) || [];
        for (const playerTelegramId of players) {
          if (playerTelegramId !== telegramId) {
            const playerUser = await User.findOne({ telegramId: playerTelegramId });
            if (!playerUser) continue;

            await GameHistory.create({
              sessionId: strGameSessionId,
              gameId: gameId.toString(),
              username: playerUser.username || "Unknown",
              telegramId: playerTelegramId,
              eventType: "lose",
              winAmount: 0,
              stake: stakeAmount,
              createdAt: new Date(),
            });
          }
        }

        await GameControl.findOneAndUpdate({ gameId: gameId.toString(), strGameSessionId }, { isActive: false });
        await syncGameIsActive(gameId, false);


         // Save winner info in Redis for reconnecting players
              await redis.set(
                `winnerInfo:${gameId}`,
                JSON.stringify({
                  winnerName: winnerUser.username || "Unknown",
                  prizeAmount,
                  playerCount,
                  boardNumber: cartelaId,
                  board,
                  winnerPattern,
                  telegramId,
                  gameId
                }),
                {
                  EX: 60 * 5, // expire in 5 minutes
                }
              );



        await Promise.all([
          redis.del(`gameRooms:${gameId}`),
          redis.del(`gameCards:${gameId}`),
          redis.del(`gameDraws:${strGameSessionId}`),
          redis.del(`gameActive:${gameId}`),
          redis.del(`countdown:${gameId}`),
          redis.del(`activeDrawLock:${gameId}`),
          redis.del(`gameDrawState:${gameId}`),
          redis.del(`gameSessionId:${gameId}`),
        ]);

        await GameCard.updateMany({ gameId }, { isTaken: false, takenBy: null });

        await resetRound(String(gameId), io, state, redis);
        io.to(gameId).emit("gameEnded");

      } catch (error) {
        console.error("🔥 Error processing winner:", error);
        // You can emit an error to the user if you want here
      }
    }



    // ✅ Handle playerLeave event
    socket.on("playerLeave", async ({ gameId, telegramId }, callback) => {
    const strTelegramId = String(telegramId);
    const strGameId = String(gameId);
    console.log("outside if inside playerLeave");

    try {
        console.log("inside if inside playerLeave");
        console.log(`🚪 Player ${telegramId} is leaving game ${gameId}`);

        // --- CRITICAL ADDITION: UNSET THE RESERVATION LOCK ---
        // This is the key change to support the "lock now, deduct at end" flow.
        // If the player leaves, their reserved spot is freed up immediately.
        const userUpdateResult = await User.updateOne(
            { telegramId: strTelegramId, reservedForGameId: strGameId },
            { $unset: { reservedForGameId: "" } }
        );

        if (userUpdateResult.modifiedCount > 0) {
            console.log(`✅ Balance reservation lock for player ${telegramId} released.`);
        } else {
            console.log(`⚠️ No balance reservation lock found for player ${telegramId}.`);
        }

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
                    socketsInTargetRoom.forEach(sId => console.log(`   - Active socket in room '${gameId}': ${sId}`));
                } else {
                    console.log(`   - Room '${gameId}' appears to be EMPTY.`);
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
            redis.hDel("userSelectionsByTelegramId", strTelegramId), // ✅ Add this
            redis.sRem(getGameRoomsKey(gameId), strTelegramId),
            deleteCardsByTelegramId(strGameId, strTelegramId),
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
    let strTelegramId = null; // Declare here
    let strGameId = null;     // Declare here
    let strGameSessionId = null; 

    // 1. Try to retrieve info from 'lobby' phase (userSelections)
    const userSelectionPayloadRaw = await redis.hGet("userSelections", socket.id);
    if (userSelectionPayloadRaw) {
        try {
            userPayload = JSON.parse(userSelectionPayloadRaw);
            disconnectedPhase = userPayload.phase || 'lobby'; // Default to 'lobby' if phase not explicitly set
            console.log(`DEBUG: Socket ${socket.id} found in userSelections. Payload: ${userSelectionPayloadRaw}, Deduced Phase: ${disconnectedPhase}`);
        } catch (e) {
            console.error(`❌ Error parsing userSelections payload for ${socket.id}: ${e.message}. Cleaning up.`);
            await redis.hDel("userSelections", socket.id); // Clean up corrupted data
            // userPayload, disconnectedPhase, strTelegramId, strGameId remain null if parsing fails
        }
    }

    // 2. If not found in 'lobby' OR if parsing failed for lobby, try 'joinGame' phase
    if (!userPayload) {
        const joinGamePayloadRaw = await redis.hGet("joinGameSocketsInfo", socket.id);
        if (joinGamePayloadRaw) {
            try {
                userPayload = JSON.parse(joinGamePayloadRaw);
                disconnectedPhase = userPayload.phase || 'joinGame'; // Default to 'joinGame'
                console.log(`DEBUG: Socket ${socket.id} found in joinGameSocketsInfo. Payload: ${joinGamePayloadRaw}, Deduced Phase: ${disconnectedPhase}`);
            } catch (e) {
                console.error(`❌ Error parsing joinGameSocketsInfo payload for ${socket.id}: ${e.message}. Cleaning up.`);
                await redis.hDel("joinGameSocketsInfo", socket.id); // Clean up corrupted data
                // userPayload, disconnectedPhase, strTelegramId, strGameId remain null if parsing fails
            }
        }
    }

    // Now, attempt to extract strTelegramId and strGameId from userPayload
    // This must happen AFTER userPayload is potentially assigned in the blocks above
    if (userPayload && typeof userPayload.telegramId !== 'undefined' && typeof userPayload.gameId !== 'undefined') {
        strTelegramId = String(userPayload.telegramId);
        strGameId = String(userPayload.gameId);
    }

    // Early exit if crucial info is missing or corrupted
    if (!userPayload || !strTelegramId || !strGameId || !disconnectedPhase) {
        console.log("❌ No relevant user session info found or payload corrupted for this disconnected socket ID. Skipping full disconnect cleanup.");
        // If an activeSocket key exists without corresponding payload, it might be stale. Clean it up immediately.
        await redis.del(`activeSocket:${socket.handshake.query.telegramId || 'unknown'}:${socket.id}`);
        return;
    }

    console.log(`[DISCONNECT DEBUG] Processing disconnect for User: ${strTelegramId}, Game: ${strGameId}, Socket: ${socket.id}, Final Deduced Phase: ${disconnectedPhase}`);

    // --- Initial cleanup for the specific disconnected socket TTL key ---
    // Removed hDel for userSelections and joinGameSocketsInfo here.
    // They will be handled by the specific phase cleanup functions if they expire.
    await redis.del(`activeSocket:${strTelegramId}:${socket.id}`); // Delete the specific active socket TTL key
    console.log(`🧹 Cleaned up temporary activeSocket record for disconnected socket ${socket.id}.`);

    // --- Determine remaining active sockets for this user in THIS specific game ---
    const allActiveSocketKeysForUser = await redis.keys(`activeSocket:${strTelegramId}:*`);
    let remainingSocketsForThisGameCount = 0;
    // currentActiveSocketsInfo is not used in the remaining logic below, so can be removed if not needed elsewhere.
    // let currentActiveSocketsInfo = []; // To hold parsed info of other active sockets

    const multiGetCommands = redis.multi();
    const otherSocketIds = [];

    for (const key of allActiveSocketKeysForUser) {
        const otherSocketId = key.split(':').pop();
        if (otherSocketId === socket.id) continue; // Skip the currently disconnected socket

        otherSocketIds.push(otherSocketId);
        multiGetCommands.hGet("userSelections", otherSocketId);     // Try lobby info
        multiGetCommands.hGet("joinGameSocketsInfo", otherSocketId); // Try joinGame info
    }

    // Execute all batched commands to get info for other sockets
    const otherSocketPayloadsRaw = await multiGetCommands.exec();

    let staleKeysToDelete = [];
    for (let i = 0; i < otherSocketIds.length; i++) {
        const otherSocketId = otherSocketIds[i];
        // multi().exec() returns an array of results, where each result is [error, value].
        // So, userSelectionResult[1] is the value.
        const userSelectionResult = otherSocketPayloadsRaw[i * 2];
        const joinGameResult = otherSocketPayloadsRaw[i * 2 + 1];

        let otherSocketInfo = null;
        let otherSocketPhase = null;

        // Check userSelections first
        if (userSelectionResult && userSelectionResult[0] === null && userSelectionResult[1]) {
            try {
                otherSocketInfo = JSON.parse(userSelectionResult[1]);
                otherSocketPhase = otherSocketInfo.phase || 'lobby';
            } catch (e) {
                console.error(`❌ Error parsing userSelections payload for other socket ${otherSocketId}: ${e.message}. Marking for cleanup.`);
                await redis.hDel("userSelections", otherSocketId);
                staleKeysToDelete.push(`activeSocket:${strTelegramId}:${otherSocketId}`);
            }
        }
        // If not in userSelections, check joinGameSocketsInfo
        else if (joinGameResult && joinGameResult[0] === null && joinGameResult[1]) {
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
            // currentActiveSocketsInfo.push(otherSocketInfo); // Only if you need this info later
        }
    }

    if (staleKeysToDelete.length > 0) {
        await redis.del(...staleKeysToDelete);
        console.log(`🧹 Cleaned up ${staleKeysToDelete.length} stale activeSocket keys.`);
    }

    console.log(`[DISCONNECT DEBUG] Remaining active sockets for ${strTelegramId} in game ${strGameId}: ${remainingSocketsForThisGameCount}`);

    // --- Grace Period Management based on whether this was the last socket for THIS SPECIFIC PHASE ---
    const timeoutKeyForPhase = `${strTelegramId}:${strGameId}:${disconnectedPhase}`; // THIS IS THE KEY CHANGE

    // Clear any *existing* pending timeout for this user/game/PHASE
    if (pendingDisconnectTimeouts.has(timeoutKeyForPhase)) {
        clearTimeout(pendingDisconnectTimeouts.get(timeoutKeyForPhase));
        pendingDisconnectTimeouts.delete(timeoutKeyForPhase);
        console.log(`🕒 Cleared existing pending disconnect timeout for ${timeoutKeyForPhase}.`);
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
                        { GameSessionId: strGameSessionId },
                        { isActive: false, totalCards: 0, players: [], endedAt: new Date() }
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
                const gameControl = await GameControl.findOne({ gameId: strGameId, GameSessionId: strGameSessionId });
                if (gameControl) {
                    gameControl.players = gameControl.players.filter(id => id !== Number(strTelegramId));
                    await gameControl.save();
                    console.log("🕸️🕸️🏠 player is removed from gamecontrol", strGameId, strTelegramId);
                }
                
                console.log(`👤 ${strTelegramId} removed from gameRooms after joinGame grace period expiry for game ${strGameId}.`);

                const playerCount = await redis.sCard(`gameRooms:${strGameId}`);
                io.to(strGameId).emit("playerCountUpdate", { gameId: strGameId, playerCount });
                console.log(`📊 Broadcasted counts for game ${strGameId}: Total Players = ${playerCount} after joinGame grace period cleanup.`);

                // Release card if held and owned by this user (this block was also in lobby, but good to keep if a player holds a card from joinGame)
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
                            io.to(strGameId).emit("cardReleased", {
                                cardId: Number(userHeldCardId),
                                telegramId: strTelegramId,
                            });
                            console.log(`✅ Card ${userHeldCardId} released for ${strTelegramId} (disconnected from joinGame).`);
                        }
                    }
                }
                await redis.hDel("userSelectionsByTelegramId", strTelegramId); // Clean up overall persisted selection for this user

                await User.findOneAndUpdate(
                    { telegramId: strTelegramId, reservedForGameId: strGameId },
                    { $unset: { reservedForGameId: "" } }
                );

                if (playerCount === 0) {
                    console.log(`✅ All players have left game room ${strGameId}. Calling resetRound.`);
                    resetRound(strGameId, io, state, redis);
                }

                // Check if the game is completely empty across ALL player sets after this cleanup
                const totalPlayersGamePlayers = await redis.sCard(`gamePlayers:${strGameId}`);
                console.log("🚀🔥🚀🔥 total players", totalPlayersGamePlayers);
                const numberOfPlayersLobby = await redis.sCard(`gameSessions:${strGameId}`) || 0; // Check lobby too
                if (playerCount === 0 && numberOfPlayersLobby === 0 && totalPlayersGamePlayers === 0) {
                    console.log(`🧹 Game ${strGameId} empty after joinGame phase grace period. Triggering full game reset.`);
                    await GameControl.findOneAndUpdate(
                        { gameId: strGameId },
                        { GameSessionId: strGameSessionId },
                        { isActive: false, totalCards: 0, players: [], endedAt: new Date() }
                    );
                    await syncGameIsActive(strGameId, false);
                    resetGame(strGameId, io, state, redis);
                    console.log(`Game ${strGameId} has been fully reset.`);
                }
            };
        }

        if (remainingActiveSocketsCount === 0) {
            // This was the user's last active socket for THIS GAME for the specific 'disconnectedPhase'.
            // Start a timer for the full cleanup of THIS PHASE.
            const timeoutId = setTimeout(async () => {
                try {
                    if (cleanupFunction) { // Ensure cleanupFunction is defined
                        await cleanupFunction();
                    } else {
                        console.warn(`⚠️ No cleanup function defined for phase: ${disconnectingPhase} and user: ${strTelegramId}`);
                    }
                } catch (e) {
                    console.error(`❌ Error during grace period cleanup for ${timeoutKeyForPhase}:`, e);
                } finally {
                    // Only delete the specific phase timeout after it has completed
                    pendingDisconnectTimeouts.delete(timeoutKeyForPhase);
                }
            }, gracePeriodDuration);

            pendingDisconnectTimeouts.set(timeoutKeyForPhase, timeoutId);
            console.log(`🕒 User ${strTelegramId} has no remaining active sockets for game ${strGameId} in '${disconnectingPhase}' phase. Starting ${gracePeriodDuration / 1000}-second grace period timer for '${disconnectingPhase}' phase.`);
        } else {
            // User still has other active sockets for this game. No full cleanup timer needed for THIS PHASE.
            console.log(`ℹ️ ${strTelegramId} disconnected from '${disconnectingPhase}' phase via socket (${socket.id}) but still has ${remainingActiveSocketsCount} other active sockets in game ${strGameId}. No grace period timer started for THIS PHASE.`);

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
            // This check ensures a full game reset if all unique players are gone, regardless of individual socket counts.
            const totalPlayersGamePlayers = await redis.sCard(`gamePlayers:${strGameId}`);
            const numberOfPlayersLobby = await redis.sCard(`gameSessions:${strGameId}`) || 0;
            const playerCountGameRooms = await redis.sCard(`gameRooms:${strGameId}`) || 0;

            if (totalPlayersGamePlayers === 0 && numberOfPlayersLobby === 0 && playerCountGameRooms === 0) {
                console.log(`🧹 No unique players left in game ${strGameId} across all phases after partial disconnect. Triggering full game reset.`);
                await GameControl.findOneAndUpdate(
                    { gameId: strGameId },
                    { GameSessionId: strGameSessionId },
                    { isActive: false, totalCards: 0, players: [], endedAt: new Date() }
                );
                await syncGameIsActive(strGameId, false);
                resetGame(strGameId, io, state, redis);
                console.log(`Game ${strGameId} has been fully reset after partial disconnect.`);
            }
        }
    };

    // Call the helper function to manage grace period and cleanup
    // Pass the determined disconnectedPhase and the count of other sockets for this game
    await determineGracePeriodAndCleanup(disconnectedPhase, remainingSocketsForThisGameCount);
});
  });
};