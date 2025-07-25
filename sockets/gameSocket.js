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
const { // <-- Add this line
    getGameActiveKey,
    getCountdownKey,
    getActiveDrawLockKey,
    getGameDrawStateKey,
    getGameDrawsKey,
    getGameSessionsKey,
    getGamePlayersKey, // You also use this
    getGameRoomsKey,   // You also use this
    // Add any other specific key getters you defined in redisKeys.js
} = require("../utils/redisKeys"); // <-- Make sure the path is correct



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
};

  io.on("connection", (socket) => {
      console.log("🟢 New client connected");
      console.log("Client connected with socket ID:", socket.id);
      // User joins a game

   //socket.emit("connected")

    // User joins a game
// User joins a game
socket.on("userJoinedGame", async ({ telegramId, gameId }) => {
    console.log("userJoined invoked");
    const strGameId = String(gameId);
    const strTelegramId = String(telegramId);

    try {
        const userSelectionKey = `userSelections`;
        const gameCardsKey = `gameCards:${strGameId}`;
        const sessionKey = `gameSessions:${strGameId}`; // Card selection lobby
        const gamePlayersKey = `gamePlayers:${strGameId}`; // Overall game players (for all players, potentially more than just lobby)

        console.log(`Backend: Processing userJoinedGame for Telegram ID: ${strTelegramId}, Game ID: ${strGameId}`);
        console.log(`Backend: Attempting to add ${strTelegramId} to Redis SET: ${sessionKey}`);

        await redis.set(`activeSocket:${strTelegramId}:${socket.id}`, '1', 'EX', ACTIVE_SOCKET_TTL_SECONDS);
        socket.join(strGameId);
        await redis.hSet(userSelectionKey, socket.id, JSON.stringify({ telegramId: strTelegramId, gameId: strGameId, cardId: null, card: null }));

        // Add to card selection lobby
        await redis.sAdd(sessionKey, strTelegramId);
        // Add to the overall game players set
        await redis.sAdd(gamePlayersKey, strTelegramId);

        console.log(`Backend: Successfully added ${strTelegramId} to SET ${sessionKey}.`);
        const currentSessionMembers = await redis.sMembers(sessionKey);
        console.log(`Backend: Current members in SET ${sessionKey}:`, currentSessionMembers);

        console.log(`Backend: Successfully added ${strTelegramId} to SET ${gamePlayersKey}.`);
        const currentGamePlayersMembers = await redis.sMembers(gamePlayersKey);
        console.log(`Backend: Current members in SET ${gamePlayersKey}:`, currentGamePlayersMembers);

        // ⭐⭐⭐ CRITICAL CHANGE HERE ⭐⭐⭐
        // Calculate numberOfPlayers for the 'gameid' event (card selection lobby)
        // Use 'sessionKey' as per your clarification
        const numberOfPlayersInLobby = await redis.sCard(sessionKey); 
        console.log(`Backend: Calculated numberOfPlayers for ${sessionKey} (card selection lobby): ${numberOfPlayersInLobby}`);

        io.to(strGameId).emit("gameid", {
            gameId: strGameId,
            numberOfPlayers: numberOfPlayersInLobby, // Use the lobby count here
        });
        const allTakenCardsData = await redis.hGetAll(gameCardsKey); // Get all cardId -> telegramId mappings

        const initialCardsState = {};
        for (const cardId in allTakenCardsData) {
            initialCardsState[cardId] = {
                cardId: Number(cardId),
                takenBy: allTakenCardsData[cardId],
                isTaken: true
            };
        }

        // Emit this initial state ONLY to the specific client that just joined (using their socket.id)
        socket.emit("initialCardStates", { takenCards: initialCardsState });
        console.log(`Backend: Sent 'initialCardStates' to ${strTelegramId} for game ${strGameId}. Total taken cards: ${Object.keys(initialCardsState).length}`);
        // --- END CONFIRMATION ---

        console.log(`Backend: Emitted 'gameid' to room ${strGameId} with numberOfPlayers: ${numberOfPlayers}`);
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

            //console.log(`🧹 Card ${strCardId} released by ${strTelegramId}`);
          }
        } catch (err) {
          console.error("unselectCardOnLeave error:", err);
        }
      });



     socket.on("joinGame", async ({ gameId, telegramId }) => {
        try {
          // Validate user is registered in the game via MongoDB
          const game = await GameControl.findOne({ gameId });
          if (!game || !game.players.includes(telegramId)) {
            console.warn(`🚫 Blocked unpaid user ${telegramId} from joining game ${gameId}`);
            socket.emit("joinError", { message: "You are not registered in this game." });
            return;
          }

          // Add player to Redis set for gameRooms (replace in-memory Set)
        
          await redis.sAdd(`gameRooms:${gameId}`, telegramId);
          const playerCountAfterJoin = await redis.sCard(`gameRooms:${gameId}`);
          //console.log(`[joinGame] Player ${telegramId} joined game ${gameId}, total players now: ${playerCountAfterJoin}`);

          // Join the socket.io room
          socket.join(gameId);

          // Get current player count from Redis set cardinality
          const playerCount = await redis.sCard(`gameRooms:${gameId}`);

          // Emit updated player count to the game room
          io.to(gameId).emit("playerCountUpdate", {
            gameId,
            playerCount,
          });

          // Confirm to the socket the gameId and telegramId
          socket.emit("gameId", { gameId, telegramId });
        } catch (err) {
          console.error("❌ Redis error in joinGame:", err);
        }
      });


      // socket.on("getPlayerCount", ({ gameId }) => {
        
      //     const playerCount = gameRooms[gameId]?.length || 0;
      //     socket.emit("playerCountUpdate", { gameId, playerCount });
      // });


    socket.on("gameCount", async ({ gameId }) => {
        const strGameId = String(gameId); // Ensure gameId is always a string for Redis keys
        const activeGameKey = getGameActiveKey(strGameId);
        const countdownKey = getCountdownKey(strGameId);
        const lockKey = getActiveDrawLockKey(strGameId);
        const gameDrawStateKey = getGameDrawStateKey(strGameId);
        const gameDrawsKey = getGameDrawsKey(strGameId);
        const gameSessionsKey = getGameSessionsKey(strGameId); // Use helper for gameSessions

        try {
            // 1. CLEANUP essential Redis keys and intervals BEFORE starting countdown
            // Do NOT clear cards/gameRooms/gameSessions so players can join/select cards
            await Promise.all([
                redis.del(activeGameKey),
                redis.del(countdownKey),
                redis.del(lockKey),
                redis.del(gameDrawStateKey),
                redis.del(gameDrawsKey),
            ]);

            // Clear in-memory intervals
            if (state.countdownIntervals[strGameId]) {
                clearInterval(state.countdownIntervals[strGameId]);
                delete state.countdownIntervals[strGameId];
            }
            if (state.drawIntervals[strGameId]) {
                clearInterval(state.drawIntervals[strGameId]);
                delete state.drawIntervals[strGameId];
            }
            // Also clear drawStartTimeouts and activeDrawLocks if they are per-game
            if (state.drawStartTimeouts[strGameId]) {
                clearTimeout(state.drawStartTimeouts[strGameId]);
                delete state.drawStartTimeouts[strGameId];
            }
            if (state.activeDrawLocks[strGameId]) {
                delete state.activeDrawLocks[strGameId];
            }


            // 2. Check if game is already active or preparing (using cleaned keys)
            const [isActive, hasCountdown, hasLock] = await Promise.all([
                redis.get(activeGameKey),
                redis.get(countdownKey),
                redis.get(lockKey),
            ]);

            if (isActive || hasCountdown || hasLock) {
                console.log(`⚠️ Game ${strGameId} is already preparing or running. Ignoring gameCount event.`);
                return;
            }

            // 3. Mark game as active preparing
            await redis.set(activeGameKey, "true");
            state.gameIsActive[strGameId] = true; // Sync in-memory state

            // 4. Prepare shuffled numbers and save to Redis under gameDrawStateKey
            const numbers = Array.from({ length: 75 }, (_, i) => i + 1).sort(() => Math.random() - 0.5);
            await redis.set(gameDrawStateKey, JSON.stringify({ numbers, index: 0 }));

            // 5. Create or update GameControl in DB
            const existing = await GameControl.findOne({ gameId: strGameId });
            const sessionId = uuidv4();
            state.gameSessionIds[strGameId] = sessionId; // Using state.gameSessionIds to store sessionId
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

            // 6. Countdown logic via Redis and setInterval
            let countdownValue = 5;
            await redis.set(countdownKey, countdownValue.toString());

            io.to(strGameId).emit("countdownTick", { countdown: countdownValue }); // Emit initial tick

            state.countdownIntervals[strGameId] = setInterval(async () => {
                if (countdownValue > 0) {
                    countdownValue--;
                    io.to(strGameId).emit("countdownTick", { countdown: countdownValue });
                    await redis.set(countdownKey, countdownValue.toString());
                } else {
                    clearInterval(state.countdownIntervals[strGameId]);
                    delete state.countdownIntervals[strGameId];
                    await redis.del(countdownKey);
                    console.log(`[gameCount] Countdown ended for game ${strGameId}`);

                    const currentPlayersInRoom = (await redis.sCard(getGameRoomsKey(strGameId))) || 0;
                    const prizeAmount = stakeAmount * currentPlayersInRoom;

                    if (currentPlayersInRoom === 0) {
                        console.log("🛑 No players left in game room after countdown. Stopping game initiation.");
                        // No players in the room, so don't start the game.
                        // `resetRound` or `resetGame` not explicitly called here, but `playerLeave`/`disconnect`
                        // will handle full cleanup if all total players also leave.
                        io.to(strGameId).emit("gameNotStarted", {
                            gameId: strGameId,
                            message: "Not enough players in game room to start.",
                        });
                        return;
                    }

                    // --- CRITICAL RESET FOR GAME START (SESSION-ONLY RESET) ---
                    // This is your specific requirement for gameSession reset when moving to play.
                    await redis.del(gameSessionsKey); // Clear lobby sessions
                    console.log(`🧹 ${gameSessionsKey} cleared as game started.`);

                    // Mark all GameCards for this game as taken (locked) at the start of the game
                    await GameCard.updateMany({ gameId: strGameId }, { isTaken: true });
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
                    await redis.set(activeGameKey, "true");
                    state.gameIsActive[strGameId] = true;
                    state.gameReadyToStart[strGameId] = true; // Indicate game is ready to start drawing

                    io.to(strGameId).emit("cardsReset", { gameId: strGameId }); // Inform clients cards are locked/reset
                    io.to(strGameId).emit("gameStart", { gameId: strGameId }); // Signal clients the game has officially started

                    // Start drawing numbers if not already running
                    if (!state.drawIntervals[strGameId]) {
                        await startDrawing(strGameId, io); // Ensure startDrawing handles the state, redis parameters it needs
                    }
                }
            }, 1000);
        } catch (err) {
            console.error(`❌ Error in gameCount setup for ${gameId}:`, err.message);

            // Ensure cleanup on error for initial setup keys
            delete state.gameDraws[strGameId];
            delete state.countdownIntervals[strGameId];
            delete state.gameSessionIds[strGameId]; // Clear this in-memory if setup failed

            await Promise.all([
                redis.del(getGameDrawsKey(strGameId)),
                redis.del(getCountdownKey(strGameId)),
                redis.del(getGameActiveKey(strGameId)),
                redis.del(getActiveDrawLockKey(strGameId)),
                redis.del(getGameDrawStateKey(strGameId)),
            ]);
            io.to(strGameId).emit("gameNotStarted", { gameId: strGameId, message: "Error during game setup. Please try again." });
        }
    });




   async function startDrawing(gameId, io) {
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

        // Reset all cards to not taken at the start of drawing (if not handled by countdown ending)
        // If GameCards are marked `isTaken: true` in `gameCount` then this should not be `false` here unless it's a new round.
        // Assuming `gameCount` is meant to lock cards for the *current* game.
        // `resetRound` handles `isTaken: false`, so we shouldn't do it here unless `startDrawing` can be called independently.
        // If `startDrawing` is ONLY called after `gameCount`'s successful start, this line might be redundant or incorrect.
        // await GameCard.updateMany({ gameId: strGameId }, { isTaken: false, takenBy: null }); // Potentially remove or move this

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

                    // ⭐ "GAMEROOM RESET ONLY" TRIGGER: GAME ROOM PLAYERS ZERO ⭐
                    // Call resetRound as game room is empty, but don't clear full game instance.
                    await resetRound(strGameId, io, state, redis);

                    // Update GameControl to inactive, as this round ended due to abandonment
                    await GameControl.findOneAndUpdate({ gameId: strGameId }, { isActive: false });
                    await syncGameIsActive(strGameId, false); // Sync your in-memory/global active state

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

                    // ⭐ "GAMEROOM RESET ONLY" TRIGGER: ALL NUMBERS DRAWN ⭐
                    // This typically means the round has ended, but there might not be a winner.
                    // This should trigger a round reset, not necessarily a full game purge.
                    await resetRound(strGameId, io, state, redis);

                    // Update GameControl to inactive if the round ended without a winner
                    await GameControl.findOneAndUpdate({ gameId: strGameId }, { isActive: false });
                    await syncGameIsActive(strGameId, false); // Sync your in-memory/global active state

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
            }
        }, 3000); // Draw every 3 seconds
    }




    //check winner

    socket.on("checkWinner", async ({ telegramId, gameId, cartelaId, selectedNumbers }) => {
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
        await processWinner({ telegramId, gameId, cartelaId, io, selectedSet });


        //socket.emit("winnerConfirmed", { message: "Winner verified and processed!" });

      } catch (error) {
        console.error("Error in checkWinner:", error);
        socket.emit("winnerError", { message: "Internal error verifying winner." });
      }
    });






    async function processWinner({ telegramId, gameId, cartelaId, io, selectedSet }) {

      console.log("process winner", cartelaId  );
      try {
        const sessionId = gameSessionIds[gameId];
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

        // Log loses for others
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
const ACTIVE_SOCKET_TTL_SECONDS = 60; 

// Handle disconnection events
socket.on("disconnect", async (reason) => { // reason parameter is useful for debugging
   console.log(`🔴 Client disconnected: ${socket.id}, Reason: ${reason}`);

    // Step 1: Retrieve comprehensive user info associated with this specific disconnected socket.
    // This payload contains the gameId, telegramId, and potentially cardId this *specific socket* was handling.
    const userSelectionPayloadRaw = await redis.hGet("userSelections", socket.id);

    if (!userSelectionPayloadRaw) {
       console.log("❌ No user session info found for this socket ID. Skipping disconnect cleanup.");
        return;
    }

    const { telegramId, gameId, cardId: disconnectedCardId } = JSON.parse(userSelectionPayloadRaw);
    const strGameId = String(gameId);
    const strTelegramId = String(telegramId);

   console.log(`[DISCONNECT DEBUG] Processing disconnect for User: ${strTelegramId}, Game: ${strGameId}, Socket: ${socket.id}`);

    const sessionKey = `gameSessions:${strGameId}`; // Set to track unique Telegram IDs in this game's lobby.

    // Step 2: Clean up the individual socket's temporary records from Redis.
    // This is crucial for precise tracking of active connections.
    await Promise.all([
        redis.del(`activeSocket:${strTelegramId}:${socket.id}`), // Delete the specific active socket TTL key
        redis.hDel("userSelections", socket.id),              // Delete the socket.id-keyed payload
    ]);
   console.log(`🧹 Cleaned up temporary records for disconnected socket ${socket.id}.`);

    // Step 3: Determine if this user (telegramId) still has ANY other active sockets *for this specific game*.
    // This is the core logic for deciding if it's a "full disconnect" for this game.
    const allActiveSocketKeysForUser = await redis.keys(`activeSocket:${strTelegramId}:*`);
    let remainingSocketsForThisGameCount = 0;

    for (const key of allActiveSocketKeysForUser) {
        const otherSocketId = key.split(':').pop(); // Extract socket.id from the key
        const otherSocketPayloadRaw = await redis.hGet("userSelections", otherSocketId);

        if (otherSocketPayloadRaw) {
            try {
                const otherSocketInfo = JSON.parse(otherSocketPayloadRaw);
                // Count only active sockets that are still associated with the same gameId.
                if (String(otherSocketInfo.gameId) === strGameId) {
                    remainingSocketsForThisGameCount++;
                }
            } catch (e) {
                console.error(`❌ Error parsing payload for other active socket ${otherSocketId}:`, e);
                // Consider deleting malformed entries here if they cause issues.
            }
        } else {
            // This case indicates a stale `activeSocket` key without a corresponding `userSelections` entry.
            // This should ideally be cleaned up elsewhere (e.g., on `userJoinedGame` or periodically),
            // but we can also clean it here defensively.
           console.log(`ℹ️ Found stale activeSocket key ${key} without userSelections entry. Deleting.`);
            await redis.del(key);
        }
    }

   console.log(`[DISCONNECT DEBUG] Remaining active sockets for ${strTelegramId} in game ${strGameId}: ${remainingSocketsForThisGameCount}`);

    // Step 4: Act based on whether this was the user's last socket for this game.
  // Assuming strGameId, strTelegramId, disconnectedCardId, sessionKey (gameSessions),
// and activeSocket_key (activeSocket:${strTelegramId}:*) are defined above this block.

if (remainingSocketsForThisGameCount === 0) {
    console.log("inside releasing cards");
    // This user (telegramId) has truly left THIS GAME across all their tabs/devices.

    // A. Release the card if they were holding one in this game.
    const userOverallSelectionRaw = await redis.hGet("userSelectionsByTelegramId", strTelegramId);
    console.log("outside", userOverallSelectionRaw);

    if (userOverallSelectionRaw) {
        const { cardId: userHeldCardId, gameId: selectedGameId } = JSON.parse(userOverallSelectionRaw);
        console.log("user selection form userSelection key by tgid", userOverallSelectionRaw);

        // Ensure the card belongs to the game that the user is disconnecting from
        if (selectedGameId === strGameId && userHeldCardId) {
            // Note: disconnectedCardId might not always be reliable if not explicitly passed from client.
            // Rely on userOverallSelectionRaw for the authoritative card ID.
            const gameCardsKey = `gameCards:${strGameId}`;
            const cardOwner = await redis.hGet(gameCardsKey, String(userHeldCardId));

            if (cardOwner === strTelegramId) { // Confirm they are still the Redis owner of this card
                console.log("inside if statement - releasing card");
                await redis.hDel(gameCardsKey, String(userHeldCardId)); // Remove from Redis hash
                await GameCard.findOneAndUpdate( // Update MongoDB
                    { gameId: strGameId, cardId: Number(userHeldCardId) },
                    { isTaken: false, takenBy: null }
                );
                io.to(strGameId).emit("cardReleased", { cardId: Number(userHeldCardId), telegramId: strTelegramId });
                console.log(`✅ Card ${userHeldCardId} released for ${strTelegramId} due to full disconnect from game ${strGameId}.`);
            } else {
                console.log(`ℹ️ Card ${userHeldCardId} not released, not owned by ${strTelegramId} in Redis when user fully disconnected.`);
            }
        } else {
            console.log(`ℹ️ User's overall selection (card ${userHeldCardId} for game ${selectedGameId}) does not match disconnected game ${strGameId}. No card release.`);
        }
    } else {
        console.log(`ℹ️ No overall persisted selection found for ${strTelegramId}. No card to release.`);
    }


    // B. Remove the user from ALL relevant unique player sets for this game.
    await redis.sRem(sessionKey, strTelegramId); // Remove from gameSessions (card selection lobby)
    console.log(`👤 ${strTelegramId} removed from gameSessions:${strGameId}.`);

    await redis.sRem(`gameRooms:${strGameId}`, strTelegramId); // NEW: Remove from gameRooms (actual game page)
    console.log(`👤 ${strTelegramId} removed from gameRooms:${strGameId}.`);

    await redis.sRem(`gamePlayers:${strGameId}`, strTelegramId); // NEW: Remove from the overall game players set
    console.log(`👤 ${strTelegramId} removed from gamePlayers:${strGameId}.`);


    // C. Clean up the user's overall persisted selection for this game.
    // This is key: we remove the user's overall selected card *only* when they fully leave.
    await redis.hDel("userSelectionsByTelegramId", strTelegramId);
    console.log(`🧹 Removed overall persisted selection for ${strTelegramId}.`);


    // D. NEW: Broadcast the updated overall player count
    const totalPlayers = await redis.sCard(`gamePlayers:${strGameId}`);
    io.to(strGameId).emit("gameid", { gameId: strGameId, numberOfPlayers: totalPlayers });
    console.log(`[DISCONNECT SOCKET] Total players (gamePlayers) after disconnect: ${totalPlayers}`);

    // E. NEW: Trigger the central game reset check
    await checkAndResetIfEmpty(strGameId, io, redis, state); // Ensure `checkAndResetIfEmpty` is imported/accessible
    console.log(`[DISCONNECT SOCKET] Triggered checkAndResetIfEmpty for game ${strGameId}.`);


} else {
    // User still has other active sockets for this game. No card release or lobby removal.
    console.log(`ℹ️ ${strTelegramId} disconnected one socket (${socket.id}) but still has ${remainingSocketsForThisGameCount} other active sockets in game ${strGameId}.`);
}

    // Step 5: Recalculate and Broadcast the unique player count for the game.
    // This needs to happen regardless of whether it was a full disconnect or not,
    // as the specific socket's departure might reduce the count if it was the last.
    const numberOfPlayers = await redis.sCard(sessionKey) || 0;
    io.to(strGameId).emit("gameid", {
        gameId: strGameId,
        numberOfPlayers,
    });
   console.log(`📊 Broadcasted counts for game ${strGameId}: Lobby Players = ${numberOfPlayers}`);

    // Step 6: Trigger full game cleanup if no unique players are left in the lobby.
    if (numberOfPlayers === 0) {
       console.log(`🧹 No unique players left in game ${strGameId} (lobby count is 0). Triggering full game reset.`);
        await GameControl.findOneAndUpdate(
            { gameId: strGameId },
            { isActive: false, totalCards: 0, prizeAmount: 0, players: [], endedAt: new Date() }
        );
        await syncGameIsActive(strGameId, false);
        resetGame(strGameId, io, state, redis); // Ensure resetGame clears all game-specific Redis data
       console.log(`Game ${strGameId} has been fully reset.`);
    }
});
  });
};
