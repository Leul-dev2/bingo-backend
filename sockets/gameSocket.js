const User = require("../models/user");
const GameControl = require("../models/GameControl");
const GameHistory = require("../models/GameHistory")
const resetGame = require("../utils/resetGame");
const checkAndResetIfEmpty = require("../utils/checkandreset");
const redis = require("../utils/redisClient");
const  syncGameIsActive = require("../utils/syncGameIsActive");
const GameCard = require('../models/GameCard'); // Your Mongoose models
const checkBingoPattern = require("../utils/BingoPatterns")



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
    const strGameId = String(gameId);
    const strTelegramId = String(telegramId);

    try {
        const userSelectionKey = `userSelections`;
        const gameCardsKey = `gameCards:${strGameId}`;
        const sessionKey = `gameSessions:${strGameId}`; // For numberOfPlayers
        
        // NEW: Key for tracking this specific active socket with a TTL
        const activeSocketTTLKey = `activeSocket:${strTelegramId}:${socket.id}`;

        // ✅ Track the active socket ID with a TTL.
        // This key indicates that this specific socket connection is alive.
        // It's crucial to refresh this TTL on every `userJoinedGame` or regular heartbeat
        // to keep the connection alive in Redis's eyes.
        await redis.set(activeSocketTTLKey, '1', 'EX', ACTIVE_SOCKET_TTL_SECONDS);
        console.log(`[userJoinedGame] Set TTL for activeSocket:${strTelegramId}:${socket.id}`);


        // ✅ Join the Socket.IO room
        socket.join(strGameId);
        console.log(`[userJoinedGame] ${strTelegramId} joining socket.io room ${strGameId}`);

        // ✅ Prepare the session payload with null cardId/card to keep consistent shape
        const selectionPayload = JSON.stringify({
            telegramId: strTelegramId,
            gameId: strGameId,
            cardId: null, // Ensure consistent data structure from the start
            card: null,   // Ensure consistent data structure from the start
        });

        // ✅ Store session under socket.id in 'userSelections' hash.
        // This is primarily for the disconnect logic to easily retrieve user info by socket.id.
        await redis.hSet(userSelectionKey, socket.id, selectionPayload);

        // ✅ Add the user's telegramId to the 'gameSessions' SET.
        // This set tracks unique players in the game lobby.
        await redis.sAdd(sessionKey, strTelegramId); // Add to gameSessions (for numberOfPlayers)
        console.log(`[userJoinedGame] Added ${strTelegramId} to gameSessions:${strGameId}`);

        // IMPORTANT: The original code also had `redis.hSet(userSelectionKey, strTelegramId, selectionPayload);`
        // This should primarily be handled when a card is selected, to store the *last known selection*
        // for a user, not just on join. If you want a default state stored for the telegramId key
        // immediately on join, you can re-add it here, but ensure your `selectCard` updates it.

        // ✅ Emit all currently selected cards
        const cardSelections = await redis.hGetAll(gameCardsKey);
        console.log(`[userJoinedGame] Emitting currentCardSelections for ${strTelegramId} in game ${strGameId}:`, cardSelections);
        socket.emit("currentCardSelections", cardSelections || {});

        // ✅ Restore previous selection if exists (from the telegramId key in userSelections)
        // This assumes the `userSelections` hash also stores a key for `telegramId` itself,
        // which should contain the last selected card for that user across all their connections.
       let prevSelectionRaw = await redis.hGet("userSelectionsByTelegramId", strTelegramId);

      if (prevSelectionRaw) {
          const prev = JSON.parse(prevSelectionRaw);

          // Ensure the previous selection is actually for this game, and a card exists
          if (String(prev.gameId) === strGameId && prev.cardId && prev.card) {
              // Crucial Check: Is this card still actually available or owned by this user in the game's active cards?
              const cardOwner = await redis.hGet(gameCardsKey, String(prev.cardId));

              if (!cardOwner || cardOwner === strTelegramId) {
                  // Card is free OR already held by this user. Re-claim it.
                  console.log(`[userJoinedGame] Reclaiming card ${prev.cardId} for ${strTelegramId}`);

                  // 1. Re-assert ownership in gameCards hash (if it was released)
                  await redis.hSet(gameCardsKey, String(prev.cardId), strTelegramId);
                  // 2. Update MongoDB (if necessary)
                  await GameCard.findOneAndUpdate(
                      { gameId: strGameId, cardId: Number(prev.cardId) },
                      { isTaken: true, takenBy: strTelegramId },
                      { new: true, upsert: true }
                  );

                  // 3. Update *this specific socket's* payload in 'userSelections' (keyed by socket.id)
                  // This ensures your disconnect handler has correct info for this new connection.
                  const updatedSocketPayload = JSON.stringify({
                      telegramId: strTelegramId,
                      gameId: strGameId,
                      cardId: prev.cardId,
                      card: prev.card,
                  });
                  await redis.hSet(userSelectionKey, socket.id, updatedSocketPayload); // <--- Use socket.id here!

                  // 4. Emit confirmation to the client
                  socket.emit("cardConfirmed", {
                      cardId: prev.cardId,
                      card: prev.card,
                  });

                  // Example in userJoinedGame before emitting cardConfirmed:
                  console.log("Emitting cardConfirmed with data:", {
                    cardId: prev.cardId,
                    card: prev.card, // See what this actually contains
                    telegramId: strTelegramId,
                  });
                  socket.emit("cardConfirmed", { cardId: prev.cardId, card: prev.card, telegramId: strTelegramId });

                  // 5. Broadcast to others if the card wasn't already shown as taken by this user
                  // You might want to skip this if currentCardSelections already covers it.
                  io.to(strGameId).emit("otherCardSelected", {
                      telegramId: strTelegramId,
                      cardId: prev.cardId,
                  });

              } else {
                  // Card is now taken by someone else or otherwise invalid.
                  console.log(`[userJoinedGame] Card ${prev.cardId} for ${strTelegramId} in game ${strGameId} is now taken by ${cardOwner}. Not restoring.`);
                  // Optionally, clear this user's overall selection if it's no longer valid.
                  await redis.hDel("userSelectionsByTelegramId", strTelegramId);
              }
          } else {
              console.log(`[userJoinedGame] Found stale or invalid previous selection in userSelectionsByTelegramId for ${strTelegramId}.`);
              // Clear it if it's stale/invalid for this game
              await redis.hDel("userSelectionsByTelegramId", strTelegramId);
          }
      } else {
          console.log(`[userJoinedGame] No previous card selection found for ${strTelegramId} in this game.`);
      }


        await redis.sAdd(`gameSessions:${strGameId}`, String(strTelegramId));
        console.log(`👤 ${strTelegramId} added to gameSessions:${strGameId}.`);

        // ✅ Update and Broadcast player count to ALL clients in the room
        const numberOfPlayers = await redis.sCard(sessionKey);

        io.to(strGameId).emit("gameid", { // Event for numberOfPlayers (from gameSessions)
            gameId: strGameId,
            numberOfPlayers,
        });

        console.log(`✅ Re/joined: ${strTelegramId} to game ${strGameId}. Sessions=${numberOfPlayers}`);
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
          console.log("Lock status:", lock); // Should be "OK" or null

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
        const previousSelectionRaw = await redis.hGet(userSelectionsKey, strTelegramId);


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
          await redis.hSet(userSelectionsKey, strTelegramId, selectionData);
          await redis.hSet("userSelectionsByTelegramId", strTelegramId, selectionData);


          // 6️⃣ Emit
         // io.to(strTelegramId).emit("cardConfirmed", { cardId: strCardId, card: cleanCard });
          socket.emit("cardConfirmed", { cardId: strCardId, card: cleanCard });
          socket.to(strGameId).emit("otherCardSelected", { telegramId: strTelegramId, cardId: strCardId });

          const updatedSelections = await redis.hGetAll(gameCardsKey);
          io.to(strGameId).emit("currentCardSelections", updatedSelections);

          const numberOfPlayers = await redis.sCard(`gameSessions:${strGameId}`);
          io.to(strGameId).emit("gameid", { gameId: strGameId, numberOfPlayers });

          console.log(`✅ ${strTelegramId} selected card ${strCardId} in game ${strGameId}`);
        } catch (err) {
          console.error("❌ cardSelected error:", err);
          socket.emit("cardError", { message: "Card selection failed." });
        } finally {
          await redis.del(lockKey); // 🔓 Always release lock
        }
      });


      socket.on("unselectCardOnLeave", async ({ gameId, telegramId, cardId }) => {
        console.log("unselectCardOnLeave is called");
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

            await redis.hDel("userSelections", strTelegramId);
            socket.to(gameId).emit("cardAvailable", { cardId: strCardId });

            console.log(`🧹 Card ${strCardId} released by ${strTelegramId}`);
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
          console.log(`[joinGame] Player ${telegramId} joined game ${gameId}, total players now: ${playerCountAfterJoin}`);

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
      const activeGameKey = `gameActive:${gameId}`;
      const countdownKey = `countdown:${gameId}`;
      const lockKey = `activeDrawLock:${gameId}`;
      const gameDrawStateKey = `gameDrawState:${gameId}`;
      const gameDrawsKey = `gameDraws:${gameId}`;

      console.log("game count is called");

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

        if (countdownIntervals[gameId]) {
          clearInterval(countdownIntervals[gameId]);
          delete countdownIntervals[gameId];
        }
        if (drawIntervals[gameId]) {
          clearInterval(drawIntervals[gameId]);
          delete drawIntervals[gameId];
        }

        const currentPlayers = await redis.sCard(`gameRooms:${gameId}`);
        console.log(`[gameCount] Countdown ended. Current players in game ${gameId}: ${currentPlayers}`);

        // 2. Check if game is already active or preparing
        const [isActive, hasCountdown, hasLock] = await Promise.all([
          redis.get(activeGameKey),
          redis.get(countdownKey),
          redis.get(lockKey),
        ]);

        console.log("console of ", isActive, hasCountdown, hasLock);

        if (isActive || hasCountdown || hasLock) {
          console.log(`⚠️ Game ${gameId} is already preparing or running. Ignoring gameCount event.`);
          return;
        }

        // 3. Mark game as active preparing
        await redis.set(activeGameKey, "true");

        // 4. Prepare shuffled numbers and save to Redis under gameDrawStateKey
        const numbers = Array.from({ length: 75 }, (_, i) => i + 1).sort(() => Math.random() - 0.5);
        await redis.set(gameDrawStateKey, JSON.stringify({ numbers, index: 0 }));

        // 5. Create or update GameControl in DB
        const existing = await GameControl.findOne({ gameId });
        const sessionId = uuidv4();
        gameSessionIds[gameId] = sessionId;
        const stakeAmount = Number(gameId); // Ideally configurable

        if (!existing) {
          await GameControl.create({
            sessionId,
            gameId,
            stakeAmount,
            totalCards: 0,
            prizeAmount: 0,
            isActive: false,
            createdBy: "system",
          });
        } else {
          existing.sessionId = sessionId;
          existing.stakeAmount = stakeAmount;
          existing.totalCards = 0;
          existing.prizeAmount = 0;
          existing.isActive = false;
          existing.createdAt = new Date();
          await existing.save();
        }

        // 6. Countdown logic via Redis and setInterval
        let countdownValue = 5;
        await redis.set(countdownKey, countdownValue.toString());

        countdownIntervals[gameId] = setInterval(async () => {
          if (countdownValue > 0) {
            io.to(gameId).emit("countdownTick", { countdown: countdownValue });
            countdownValue--;
            await redis.set(countdownKey, countdownValue.toString());
          } else {
            clearInterval(countdownIntervals[gameId]);
            await redis.del(countdownKey);

            // Countdown ended: do card and game resets BEFORE starting the game
            const currentPlayers = (await redis.sCard(`gameRooms:${gameId}`)) || 0;
            const prizeAmount = stakeAmount * currentPlayers;

            if (currentPlayers === 0) {
              console.log("🛑 No players left. Stopping drawing...");
              // Optionally reset game here or just return
              return;
            }

            // Reset cards and player rooms/sessions in Redis (lock cards for game start)
            await Promise.all([
              redis.del(`gameCards:${gameId}`),
              // redis.del(`gameRooms:${gameId}`), // keep players to track them during game
              redis.del(`gameSessions:${gameId}`),
            ]);

            // Update DB cards: mark all cards for this game as taken (locked)
            await GameCard.updateMany({ gameId }, { isTaken: true });

            // Update GameControl DB with active game info
            await GameControl.findOneAndUpdate(
              { gameId },
              {
                $set: {
                  isActive: true,
                  totalCards: currentPlayers,
                  prizeAmount: prizeAmount,
                  createdAt: new Date(),
                },
              }
            );

            await syncGameIsActive(gameId, true);

            console.log(`✅ Game ${gameId} is now ACTIVE with ${currentPlayers} players.`);

            // Mark game as active in Redis again (to be safe)
            await redis.set(activeGameKey, "true");

            gameIsActive[gameId] = true;
            gameReadyToStart[gameId] = true;

            io.to(gameId).emit("cardsReset", { gameId });
            io.to(gameId).emit("gameStart");

            if (!drawIntervals[gameId]) {
              startDrawing(gameId, io);
            }

          }
        }, 1000);
      } catch (err) {
        console.error("❌ Error in game setup:", err.message);

        delete gameDraws[gameId];
        delete countdownIntervals[gameId];
        delete gameSessionIds[gameId];

        // Clean Redis keys on error
        await Promise.all([
          redis.del(`gameDraws:${gameId}`),
          redis.del(`countdown:${gameId}`),
          redis.del(`gameActive:${gameId}`),
          redis.del(`activeDrawLock:${gameId}`),
          redis.del(`gameDrawState:${gameId}`),
        ]);
      }
    });




    async function startDrawing(gameId, io) {

      if (drawIntervals[gameId]) {
        console.log(`⛔️ Drawing already in progress for game ${gameId}, skipping.`);
        return;
      }

      console.log(`🎯 Starting the drawing process for gameId: ${gameId}`);

      await GameCard.updateMany({ gameId }, { isTaken: false, takenBy: null });

      const gameDrawStateKey = `gameDrawState:${gameId}`;
      const gameDrawsKey = `gameDraws:${gameId}`;
      const gameRoomsKey = `gameRooms:${gameId}`;
      const activeGameKey = `gameActive:${gameId}`;

      // Clear any existing draws list at start
      await redis.del(gameDrawsKey);

      drawIntervals[gameId] = setInterval(async () => {
        try {
          // Fetch current player count
          const currentPlayers = (await redis.sCard(gameRoomsKey)) || 0;

          if (currentPlayers === 0) {
            console.log(`🛑 No players left in game ${gameId}. Stopping drawing...`);
            clearInterval(drawIntervals[gameId]);
            delete drawIntervals[gameId];

            resetGame(gameId, io, state, redis);

            await GameControl.findOneAndUpdate({ gameId: gameId.toString() }, { isActive: false });
            await syncGameIsActive(gameId, false);

            io.to(gameId).emit("gameEnded");
            await redis.del(activeGameKey);
            await redis.del(gameDrawsKey);
            await redis.del(gameDrawStateKey);
            return;
          }

          // Read game state from Redis
          const gameDataRaw = await redis.get(gameDrawStateKey);
          if (!gameDataRaw) {
            console.log(`❌ No game draw data found for ${gameId}, stopping draw.`);
            clearInterval(drawIntervals[gameId]);
            delete drawIntervals[gameId];
            return;
          }
          const gameData = JSON.parse(gameDataRaw);

          // Check if all numbers drawn
          if (gameData.index >= gameData.numbers.length) {
            clearInterval(drawIntervals[gameId]);
            delete drawIntervals[gameId];
            io.to(gameId).emit("allNumbersDrawn");
            console.log(`🎯 All numbers drawn for game ${gameId}`);

            resetGame(gameId, io, state, redis);
            await redis.del(activeGameKey);
            await redis.del(gameDrawsKey);
            await redis.del(gameDrawStateKey);
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

          io.to(gameId).emit("numberDrawn", { number, label });

        } catch (error) {
          console.error(`❌ Error during drawing interval for game ${gameId}:`, error);
          clearInterval(drawIntervals[gameId]);
          delete drawIntervals[gameId];
        }
      }, 3000);
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

        resetGame(gameId, io, state, redis);
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
        let userSelectionRaw = await redis.hGet("userSelections", socket.id);
        if (!userSelectionRaw) {
          userSelectionRaw = await redis.hGet("userSelections", strTelegramId);
        }
    console.log("userSelectionRaw:", userSelectionRaw);


        let userSelection = userSelectionRaw ? JSON.parse(userSelectionRaw) : null;
        console.log("cardId in userSelection:", userSelection?.cardId);


        // Free selected card if owned by this player
        if (userSelection?.cardId) {
          console.log("inside clearening logic inplayer leave")
          const cardOwner = await redis.hGet(`gameCards:${gameId}`, userSelection.cardId);
          console.log("card ownerrrr", cardOwner);
          if (cardOwner === telegramId) {
            // Free card in Redis
            await redis.hDel(`gameCards:${gameId}`, userSelection.cardId);

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

            io.to(gameId).emit("cardAvailable", { cardId: userSelection.cardId });
          }
        }

        // Remove userSelections entries by both socket.id and telegramId after usage
     // Remove userSelections entries by both socket.id and telegramId
          await Promise.all([
            redis.hDel("userSelections", socket.id),
            redis.hDel("userSelections", strTelegramId),
            redis.hDel("userSelectionsByTelegramId", strTelegramId), // ✅ Add this
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
    if (remainingSocketsForThisGameCount === 0) {
      console.log("inside releasing cards");
        // This user (telegramId) has truly left THIS GAME across all their tabs/devices.
        console.log()
        // A. Release the card if they were holding one in this game.
        // Check `userSelectionsByTelegramId` (the user's overall game state) to see what card they owned.
        const userOverallSelectionRaw = await redis.hGet("userSelectionsByTelegramId", strTelegramId);
        console.log("outside", userOverallSelectionRaw);
        if (userOverallSelectionRaw) {
            const { cardId: userHeldCardId } = JSON.parse(userOverallSelectionRaw);
            console.log("user selection form userSelection key by tgid", userOverallSelectionRaw);

            if (userHeldCardId && String(userHeldCardId) === String(disconnectedCardId)) { // Ensure it's the specific card they were holding
                const gameCardsKey = `gameCards:${strGameId}`;
                const cardOwner = await redis.hGet(gameCardsKey, String(userHeldCardId));

                if (cardOwner === strTelegramId) { // Confirm they are still the Redis owner of this card
                  console.log("inside if statement")
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
            }
        }

        // B. Remove the user from the unique players set for this game.
        await redis.sRem(sessionKey, strTelegramId);
        console.log(`👤 ${strTelegramId} removed from gameSessions:${strGameId}.`);

        // C. Clean up the user's overall persisted selection for this game.
        // This is key: we remove the user's overall selected card *only* when they fully leave.
        await redis.hDel("userSelectionsByTelegramId", strTelegramId);
        console.log(`🧹 Removed overall persisted selection for ${strTelegramId}.`);

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
