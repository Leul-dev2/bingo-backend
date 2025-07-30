const User = require("../models/user");
const GameControl = require("../models/GameControl");
const GameConfiguration = require('../models/GameConfiguration');
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
    getGameSessionIdKey,
    getGamePlayersKey, // You also use this
    getGameRoomsKey,   // You also use this
    getCardsKey,
    getUserSelectionsByTelegramIdKey,
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
        console.log("joinGame is invoked 🔥🔥🔥 for gameId:", gameId, "telegramId:", telegramId);
        try {
            const strGameId = String(gameId);
            const strTelegramId = String(telegramId); // Keep this as string

            // 1. Validate if the user is in the game type's lobby (meaning they paid via /start)
            // Use strTelegramId here!
            const isUserInLobby = await redis.sIsMember(getGameRoomsKey(strGameId), strTelegramId);
            if (!isUserInLobby) {
                console.warn(`🚫 Blocked user ${strTelegramId} from joining game type ${strGameId} lobby (not in Redis set).`);
                socket.emit("joinError", { message: "You have not paid or are not registered for this game type. Please use the 'start' button." });
                return;
            }

            // 2. Store essential info for disconnect handling for *this* specific socket
            // Use strTelegramId for Redis keys and values where strings are expected!
            await redis.hSet(`userSocketMap`, strTelegramId, socket.id);
            await redis.hSet(`socketUserMap`, socket.id, strTelegramId); // Consistent
            await redis.hSet(`joinGameSocketsInfo`, socket.id, JSON.stringify({
                telegramId: strTelegramId,
                gameId: strGameId,
                phase: 'joinGameLobby'
            }));
            console.log(`Backend: Socket ${socket.id} for ${strTelegramId} connected to game type lobby ${strGameId}.`);

            // 3. Join the socket.io room for the game *type*
            socket.join(strGameId);
            console.log(`[joinGame] Socket ${socket.id} joined Socket.IO room: ${strGameId}`);

            // 4. Update and broadcast player count for the lobby
            // sCard is fine as it doesn't take members as arguments
            const playerCount = await redis.sCard(getGameRoomsKey(strGameId));
            io.to(strGameId).emit("playerCountUpdate", {
                gameId: strGameId,
                playerCount,
            });
            console.log(`[joinGame] Player ${strTelegramId} (via socket ${socket.id}) confirmed in lobby for game type ${strGameId}, total players now: ${playerCount}`);

            // 5. Confirm to the joining client which gameId and telegramId they are interacting with
            socket.emit("gameId", { gameId: strGameId, telegramId: strTelegramId });

            // 6. Attempt to find if there's an ACTIVE SESSION for this game type and send its state
            const currentActiveSessionId = await redis.get(getGameSessionIdKey(strGameId));

            if (currentActiveSessionId) {
                const isActive = await redis.get(getGameActiveKey(currentActiveSessionId)) === "true";
                const countdownValue = await redis.get(getCountdownKey(currentActiveSessionId));
                // getGameDrawsKey will use currentActiveSessionId which is a string
                const drawnNumbersRaw = await redis.lRange(getGameDrawsKey(currentActiveSessionId), 0, -1);
                const drawnNumbers = drawnNumbersRaw.map(Number);

                if (isActive) {
                    console.log(`[joinGame] Game type ${strGameId} has active session ${currentActiveSessionId}. Sending game info.`);

                    const formattedDrawnNumbers = drawnNumbers.map(number => {
                        const letterIndex = Math.floor((number - 1) / 15);
                        const letter = ["B", "I", "N", "G", "O"][letterIndex];
                        return { number, label: `${letter}-${number}` };
                    });

                    if (formattedDrawnNumbers.length > 0) {
                        socket.emit("drawnNumbersHistory", {
                            gameId: strGameId,
                            sessionId: currentActiveSessionId,
                            history: formattedDampedNumbers
                        });
                        console.log(`[joinGame] Sent ${formattedDrawnNumbers.length} historical drawn numbers for session ${currentActiveSessionId} to ${strTelegramId}.`);
                    }

                    socket.emit("rejoinActiveGame", {
                        gameId: strGameId,
                        sessionId: currentActiveSessionId,
                        countdown: countdownValue ? Number(countdownValue) : null,
                        drawnNumbers: drawnNumbers,
                        message: "Game is currently active, rejoining.",
                        // Make sure GameCard query uses Number for telegramId if your schema expects Number,
                        // otherwise use strTelegramId if your schema expects String for takenBy
                        playerCard: await GameCard.findOne({ sessionId: currentActiveSessionId, takenBy: Number(strTelegramId) })
                    });
                } else if (countdownValue) {
                    console.log(`[joinGame] Game type ${strGameId} has session ${currentActiveSessionId} in countdown.`);
                    socket.emit("rejoinCountdown", {
                        gameId: strGameId,
                        sessionId: currentActiveSessionId,
                        countdown: Number(countdownValue),
                        message: "A new game is about to start, rejoining countdown."
                    });
                } else {
                    console.log(`[joinGame] Game type ${strGameId} has a stale session ${currentActiveSessionId}. No active game info.`);
                    socket.emit("noActiveGameInfo", {
                        gameId: strGameId,
                        message: "No active game session found for this type.",
                        sessionId: null
                    });
                }
            } else {
                console.log(`[joinGame] No active session found for game type ${strGameId}.`);
                socket.emit("noActiveGameInfo", {
                    gameId: strGameId,
                    message: "No active game session found for this type.",
                    sessionId: null
                });
            }

        } catch (err) {
            console.error("❌ Error in joinGame:", err);
            socket.emit("joinError", { message: "Failed to join game lobby. Please refresh or retry." });
        }
    });
  



 
 socket.on("gameCount", async ({ gameId }) => {
        const strGameId = String(gameId); // This is the game type (e.g., "10")

        // We now need to manage locks per game type (strGameId) for the setup phase
        // and per session (newSessionId) for the active game phase.
        // Let's use the gameId lock for the setup, and then transfer to sessionId.

        if (state.activeDrawLocks[strGameId] || state.countdownIntervals[strGameId] || state.drawIntervals[strGameId] || state.drawStartTimeouts[strGameId]) {
            console.log(`⚠️ Game type ${strGameId} already has an active countdown or draw lock in memory. Ignoring gameCount event.`);
            return;
        }

        const [redisHasSetupLock, redisIsActiveForType] = await Promise.all([
            redis.get(getActiveDrawLockKey(strGameId)), // Use gameId for setup lock
            redis.get(getGameActiveKey(strGameId)) // Check if any session for this game type is active
        ]);

        if (redisHasSetupLock === "true" || redisIsActiveForType === "true") {
            console.log(`⚠️ Game type ${strGameId} is already active or locked in Redis. Ignoring gameCount event.`);
            return;
        }

        // ⭐ Set the setup lock immediately after passing all checks ⭐
        state.activeDrawLocks[strGameId] = true;
        await redis.set(getActiveDrawLockKey(strGameId), "true", 'EX', 300); // Lock for 5 minutes for setup

        console.log(`🚀 Attempting to start countdown for game type ${strGameId}`);

        // Generate the NEW sessionId here, as we are officially starting an instance
        const newSessionId = uuidv4();

        try {
            // --- 1. CLEANUP essential Redis keys and intervals for the *old* session of this game type ---
            // If there was an old session running for this game type, clean it up.
            let oldActiveSessionIdForGameType = await redis.get(getGameSessionIdKey(strGameId));

            if (oldActiveSessionIdForGameType) {
                console.log(`Cleaning up old session ${oldActiveSessionIdForGameType} for game type ${strGameId} before starting new one.`);
                await Promise.all([
                    redis.del(getGameActiveKey(oldActiveSessionIdForGameType)),
                    redis.del(getCountdownKey(oldActiveSessionIdForGameType)),
                    redis.del(getActiveDrawLockKey(oldActiveSessionIdForGameType)), // Remove lock for old session
                    redis.del(getGameDrawStateKey(oldActiveSessionIdForGameType)),
                    redis.del(getGameDrawsKey(oldActiveSessionIdForGameType)),
                    redis.del(getGameRoomsKey(oldActiveSessionIdForGameType)),
                    // You might want to unset isTaken/takenBy on GameCard for the old session's players here
                    // if they are not re-joining the new session, but that's complex without sessionId on GameCard.
                    // For now, GameCard is managed by cardSelected.
                ]);
                // Clear in-memory state for the old session
                delete state.activeDrawLocks[oldActiveSessionIdForGameType];
                delete state.countdownIntervals[oldActiveSessionIdForGameType];
                delete state.drawIntervals[oldActiveSessionIdForGameType];
                delete state.drawStartTimeouts[oldActiveSessionIdForGameType];
                delete state.gameIsActive[oldActiveSessionIdForGameType];
                delete state.gameReadyToStart[oldActiveSessionIdForGameType];
                delete state.gameDraws[oldActiveSessionIdForGameType];
                delete state.gameSessionIds[oldActiveSessionIdForGameType];
            }


            // 2. Retrieve game configuration
            const gameConfig = await GameConfiguration.findOne({ gameId: strGameId });
            if (!gameConfig) {
                console.error(`❌ Game configuration not found for gameId: ${strGameId}. Cannot start session.`);
                io.to(strGameId).emit("gameNotStarted", {
                    gameId: strGameId,
                    sessionId: newSessionId,
                    message: "Game configuration not found. Game cannot start.",
                });
                delete state.activeDrawLocks[strGameId]; // Release setup lock
                await redis.del(getActiveDrawLockKey(strGameId));
                return;
            }
            const stakeAmount = gameConfig.stakeAmount;

            // 3. Get players from lobby (who selected cards)
            const playersInLobby = await redis.sMembers(getGameRoomsKey(strGameId)); // Using gameId for lobby
            if (playersInLobby.length === 0) {
                console.log(`🛑 No players in lobby for game type ${strGameId}. Stopping session initiation.`);
                io.to(strGameId).emit("gameNotStarted", {
                    gameId: strGameId,
                    sessionId: newSessionId,
                    message: "No players joined this game type yet. Game cannot start.",
                });
                delete state.activeDrawLocks[strGameId]; // Release setup lock
                await redis.del(getActiveDrawLockKey(strGameId));
                return;
            }

            // 4. Fetch selected cards for each player and move them to the session room
            const playersWithCards = [];
            for (const telegramId of playersInLobby) {
                const strTelegramId = String(telegramId);
                const numTelegramId = Number(telegramId); // For consistency if used elsewhere as Number

                const selectionDataRaw = await redis.hGet(getUserSelectionsByTelegramIdKey(), strTelegramId);
                if (!selectionDataRaw) {
                    console.warn(`⚠️ Player ${strTelegramId} in lobby for ${strGameId} but no card selected. Skipping.`);
                    continue; // Skip this player if no card is found
                }
                const selectedCardData = JSON.parse(selectionDataRaw);

                // Ensure the selected card is for the correct gameId (type)
                if (selectedCardData.gameId !== strGameId) {
                    console.warn(`⚠️ Player ${strTelegramId} selected card for different gameId (${selectedCardData.gameId}) than current game type (${strGameId}). Skipping.`);
                    continue;
                }

                // Move player from the game type lobby to the specific game session room
                await redis.sRem(getGameRoomsKey(strGameId), strTelegramId);
                await redis.sAdd(getGameRoomsKey(newSessionId), strTelegramId); // Now players are in session-specific room

                // Have the socket (if connected) join the *new session's room* for targeted updates
                const playerSocketId = await redis.hGet('userSocketMap', strTelegramId);
                if (playerSocketId) {
                    io.sockets.sockets.get(playerSocketId)?.join(newSessionId);
                    console.log(`Player ${strTelegramId}'s socket ${playerSocketId} joined session room ${newSessionId}`);
                }

                playersWithCards.push({
                    telegramId: numTelegramId,
                    cardId: Number(selectedCardData.cardId),
                    card: selectedCardData.card // This is the 5x5 grid from Redis
                });
            }

            if (playersWithCards.length === 0) {
                console.log(`🛑 No players with valid selected cards for game type ${strGameId}. Stopping session initiation.`);
                io.to(strGameId).emit("gameNotStarted", {
                    gameId: strGameId,
                    sessionId: newSessionId,
                    message: "No players with valid selected cards. Game cannot start.",
                });
                delete state.activeDrawLocks[strGameId]; // Release setup lock
                await redis.del(getActiveDrawLockKey(strGameId));
                return;
            }

            // 5. Create or update GameControl in DB for the NEW session
            // The GameControl document will represent this specific session instance.
            await GameControl.create({
                sessionId: newSessionId, // ⭐ Use the new sessionId here
                gameId: strGameId,
                stakeAmount: stakeAmount,
                totalCards: playersWithCards.length, // Total cards in play is actual players
                prizeAmount: stakeAmount * playersWithCards.length,
                isActive: false, // Will become true after countdown
                createdBy: "system",
                players: playersWithCards.map(p => String(p.telegramId)) // Store player telegramIds as strings
            });

            // Store the mapping from game type to current session
            await redis.set(getGameSessionIdKey(strGameId), newSessionId, 'EX', 3600 * 24); // Expires in 24 hours
            state.gameSessionIds[strGameId] = newSessionId; // Update in-memory state

            console.log(`Database record created for Game Type ${strGameId}, NEW Session: ${newSessionId}. Players: ${playersWithCards.length}`);


            // 6. Prepare shuffled numbers for this new session (using newSessionId)
            const numbers = Array.from({ length: 75 }, (_, i) => i + 1).sort(() => Math.random() - 0.5);
            await redis.set(getGameDrawStateKey(newSessionId), JSON.stringify({ numbers, index: 0 }));

            // 7. Countdown logic (using newSessionId for keys and emitting)
            let countdownValue = 15;
            await redis.set(getCountdownKey(newSessionId), countdownValue.toString());

            io.to(strGameId).emit("countdownTick", { countdown: countdownValue, sessionId: newSessionId });
            io.to(newSessionId).emit("countdownTick", { countdown: countdownValue, sessionId: newSessionId }); // Emit to the session-specific room

            state.countdownIntervals[newSessionId] = setInterval(async () => {
                if (countdownValue > 0) {
                    countdownValue--;
                    io.to(strGameId).emit("countdownTick", { countdown: countdownValue, sessionId: newSessionId });
                    io.to(newSessionId).emit("countdownTick", { countdown: countdownValue, sessionId: newSessionId });
                    await redis.set(getCountdownKey(newSessionId), countdownValue.toString());
                } else {
                    clearInterval(state.countdownIntervals[newSessionId]);
                    delete state.countdownIntervals[newSessionId];
                    await redis.del(getCountdownKey(newSessionId));
                    console.log(`[gameCount] Countdown ended for game type ${strGameId}, Session: ${newSessionId}`);

                    const currentPlayersInSessionRoom = (await redis.sCard(getGameRoomsKey(newSessionId))) || 0;

                    if (currentPlayersInSessionRoom === 0) {
                        console.log(`🛑 All players left session ${newSessionId} during countdown. Stopping game initiation.`);
                        io.to(strGameId).emit("gameNotStarted", {
                            gameId: strGameId,
                            sessionId: newSessionId,
                            message: "All players left during countdown. Game not started.",
                        });
                        delete state.activeDrawLocks[strGameId]; // Release setup lock
                        await redis.del(getActiveDrawLockKey(strGameId)); // Release setup lock
                        await syncGameIsActive(newSessionId, false); // Mark this specific session inactive
                        await redis.del(getGameSessionIdKey(strGameId)); // Remove mapping for game type
                        await resetRound(newSessionId, io, state, redis); // This should clean up specific session data
                        return;
                    }

                    // Update GameControl for this specific session
                    await GameControl.findOneAndUpdate(
                        { sessionId: newSessionId },
                        {
                            $set: {
                                isActive: true,
                                totalCards: currentPlayersInSessionRoom,
                                prizeAmount: stakeAmount * currentPlayersInSessionRoom,
                            },
                        },
                        { new: true }
                    );
                    await syncGameIsActive(newSessionId, true); // Use sessionId for specific game instance state

                    // Mark game as active in Redis for this session
                    await redis.set(getGameActiveKey(newSessionId), "true");
                    state.gameIsActive[newSessionId] = true;
                    state.gameReadyToStart[newSessionId] = true;

                    // Emit to the game type room and the specific session room
                    io.to(strGameId).emit("cardsReset", { gameId: strGameId, sessionId: newSessionId });
                    io.to(newSessionId).emit("gameStart", { gameId: strGameId, sessionId: newSessionId, playersWithCards }); // Pass actual cards to clients

                    // Start drawing numbers if not already running for this session
                    if (!state.drawIntervals[newSessionId]) {
                        await startDrawing(newSessionId, io, state, redis);
                    }
                }
            }, 1000);
        } catch (err) {
            console.error(`❌ Error in gameCount setup for ${strGameId}, Session ${newSessionId}:`, err);

            delete state.activeDrawLocks[strGameId]; // Release setup lock
            await redis.del(getActiveDrawLockKey(strGameId)); // Release setup lock
            await syncGameIsActive(newSessionId, false); // Mark session inactive on error

            // Clean up all data related to this new session
            delete state.gameDraws[newSessionId];
            delete state.countdownIntervals[newSessionId];
            delete state.gameSessionIds[strGameId]; // Clear the mapping if this session failed

            await Promise.all([
                redis.del(getGameDrawsKey(newSessionId)),
                redis.del(getCountdownKey(newSessionId)),
                redis.del(getGameActiveKey(newSessionId)),
                redis.del(getGameDrawStateKey(newSessionId)),
                redis.del(getGameRoomsKey(newSessionId)), // Clean up session-specific room
                redis.del(getGameSessionIdKey(strGameId)), // Remove the game type to session mapping
            ]);
            await GameControl.deleteOne({ sessionId: newSessionId }); // Delete the incomplete GameControl record

            io.to(strGameId).emit("gameNotStarted", { gameId: strGameId, sessionId: newSessionId, message: "Error during game setup. Please try again." });
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

      console.log("process winner", cartelaId  );
      try {
        const sessionId = await redis.get(`gameSessionId:${gameId}`);
        if (!sessionId) throw new Error(`No session ID found for gameId ${gameId}`);

        const gameData = await GameControl.findOne({ gameId: gameId.toString() });
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
        const drawn = await redis.lRange(`gameDraws:${gameId}`, 0, -1);
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
        });

        await GameHistory.create({
          sessionId,
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
              sessionId,
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

        await GameControl.findOneAndUpdate({ gameId: gameId.toString() }, { isActive: false });
        await syncGameIsActive(gameId, false);

        await Promise.all([
          redis.del(`gameRooms:${gameId}`),
          redis.del(`gameCards:${gameId}`),
          redis.del(`gameDraws:${gameId}`),
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
