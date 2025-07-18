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
        const prevSelectionRaw = await redis.hGet(userSelectionKey, strTelegramId);
        if (prevSelectionRaw) {
            const prev = JSON.parse(prevSelectionRaw);
            // Ensure the previous selection is actually for this game, to avoid cross-game issues
            if (String(prev.gameId) === strGameId && prev.cardId && prev.card) {
                socket.emit("cardConfirmed", {
                    cardId: prev.cardId,
                    card: prev.card,
                });
                console.log(`[userJoinedGame] Restored previous card selection for ${strTelegramId}: Card ${prev.cardId}`);
            }
        }

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

          // 6️⃣ Emit
          io.to(strTelegramId).emit("cardConfirmed", { cardId: strCardId, card: cleanCard });
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
      
      try {
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

        // Free selected card if owned by this player
        if (userSelection?.cardId) {
          const cardOwner = await redis.hGet(`gameCards:${gameId}`, userSelection.cardId);
          if (cardOwner === telegramId) {
            // Free card in Redis
            await redis.hDel(`gameCards:${gameId}`, userSelection.cardId);

            // Free card in DB
            await GameCard.findOneAndUpdate(
              { gameId, cardId: Number(userSelection.cardId) },
              { isTaken: false, takenBy: null }
            );

            io.to(gameId).emit("cardAvailable", { cardId: userSelection.cardId });
          }
        }

        // Remove userSelections entries by both socket.id and telegramId after usage
      await Promise.all([
        redis.hDel("userSelections", socket.id),
        redis.hDel("userSelections", strTelegramId),
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
socket.on("disconnect", async () => {
    console.log("🔴 Client disconnected:", socket.id);

    // Step 1: Lookup user information using the disconnected socket.id
    // This `userSelections` hash stores { socket.id: JSON.stringified(payload) }
    const userSelectionRaw = await redis.hGet("userSelections", socket.id);

    if (!userSelectionRaw) {
        console.log("❌ No user info found for this socket ID in userSelections. Skipping disconnect cleanup.");
        return; // Exit if we can't identify the user/game for this socket
    }

    const { telegramId, gameId, cardId } = JSON.parse(userSelectionRaw); // Extract necessary info
    const strGameId = String(gameId); // Ensure consistency in type
    const strTelegramId = String(telegramId); // Ensure consistency in type

    console.log(`[DISCONNECT DEBUG] Disconnecting user: ${strTelegramId}, Game: ${strGameId}, Socket: ${socket.id}`);

    const sessionKey = `gameSessions:${strGameId}`; // This tracks unique Telegram IDs in the lobby/card selection phase
    // const roomKey = `gameRooms:${strGameId}`; // This will track unique Telegram IDs actually in game play (once implemented)

    // Step 2: Delete the specific activeSocket key for this disconnected socket.
    // This cleans up the individual socket's active presence immediately.
    await redis.del(`activeSocket:${strTelegramId}:${socket.id}`);
    console.log(`🧹 Removed activeSocket:${strTelegramId}:${socket.id} with TTL.`);

    // Step 3: Remove ONLY this specific socket.id record from 'userSelections'
    // This cleans up the entry associated with the disconnected socket.
    await redis.hDel("userSelections", socket.id);
    console.log(`🧹 Removed socket.id ${socket.id} from userSelections.`);

    // Step 4: Determine if this user (telegramId) has ANY other active sockets.
    // This is crucial for multi-tab/multi-device handling and *releasing cards*.
    const remainingSocketsForUserInThisGame = [];
  let cursor = '0';
do {
    const scanResult = await redis.scan(cursor, 'MATCH', `activeSocket:${strTelegramId}:*`);
    const nextCursor = scanResult.cursor;
    const keys = scanResult.keys;
    cursor = nextCursor;

    for (const key of keys) {
        const activeSocketId = key.split(':').pop();
        // Check if it's not the current socket AND it belongs to the same game
        const associatedUserSelectionRaw = await redis.hGet("userSelections", activeSocketId);
        if (activeSocketId !== socket.id && associatedUserSelectionRaw) {
            try {
                const associatedInfo = JSON.parse(associatedUserSelectionRaw);
                if (String(associatedInfo.telegramId) === strTelegramId && String(associatedInfo.gameId) === strGameId) {
                    await redis.del(key); // Delete the old activeSocket key
                    await redis.hDel("userSelections", activeSocketId); // Delete its userSelection entry
                    // Optional: You might want to disconnect the old Socket.IO client forcefully here if you have access to it
                    // e.g., io.sockets.sockets.get(activeSocketId)?.disconnect(true);
                    console.log(`🧹 [userJoinedGame] Forcefully cleaned up old socket ${activeSocketId} for ${strTelegramId}.`);
                }
            } catch (e) {
                console.error(`❌ Error parsing associated user selection data for old socket ${activeSocketId}:`, e);
            }
        }
    }
} while (cursor !== '0');


// Now, proceed with setting the new activeSocket and adding to gameSessions
// ... (your existing code for userJoinedGame) ...
await redis.set(activeSocketTTLKey, '1', 'EX', ACTIVE_SOCKET_TTL_SECONDS);
console.log(`[userJoinedGame] Set TTL for activeSocket:${strTelegramId}:${socket.id}`);

    console.log(`[DISCONNECT DEBUG] Total remaining sockets for ${strTelegramId} in game ${strGameId}: ${remainingSocketsForUserInThisGame.length}`);

    if (remainingSocketsForUserInThisGame.length === 0) {
        // ✅ This was the LAST active socket for this user (telegramId) in this game.
        // The user has now truly fully disconnected from this game across all their connections.

        // NEW LOGIC: Release the card if the user was holding one and has no active connections left.
        if (cardId) { // Check if the disconnected socket *had* a card selected
            const gameCardsKey = `gameCards:${strGameId}`;
            const cardOwner = await redis.hGet(gameCardsKey, String(cardId)); // Ensure cardId is string for Redis HGET

            // Check if the disconnected user was indeed the owner of this card in Redis (from the telegramId key)
            // This is the "master" record of who holds what card.
            const userOverallSelectionRaw = await redis.hGet("userSelections", strTelegramId);
            if (userOverallSelectionRaw) {
                const { cardId: userHeldCardId } = JSON.parse(userOverallSelectionRaw);
                if (String(userHeldCardId) === String(cardId) && cardOwner === strTelegramId) {
                    await redis.hDel(gameCardsKey, String(cardId)); // Remove from Redis hash
                    await GameCard.findOneAndUpdate(
                        { gameId: strGameId, cardId: Number(cardId) },
                        { isTaken: false, takenBy: null }
                    );
                    socket.to(strGameId).emit("cardAvailable", { cardId: Number(cardId) });
                    console.log(`✅ Card ${cardId} has been released for game ${strGameId} due to ${strTelegramId} full disconnection.`);
                } else {
                    console.log(`ℹ️ Card ${cardId} was not truly held by ${strTelegramId} or already released during full disconnect check.`);
                }
            } else {
                console.log(`ℹ️ No overall user selection found for ${strTelegramId}. Card ${cardId} not released.`);
            }
        }

        await Promise.all([
            // Remove the Telegram ID from the `gameSessions` SET (lobby count)
            redis.sRem(sessionKey, strTelegramId),
            // redis.sRem(roomKey, strTelegramId), // Uncomment and use when `gameRooms` is active
            // Clean up the user's general 'last known state' entry (telegramId key in userSelections)
            // This is crucial to ensure their last chosen card state is also cleared.
            redis.hDel("userSelections", strTelegramId),
        ]);
        console.log(`👤 ${strTelegramId} fully left game ${strGameId}. Removed from Redis unique player sets and their last known selection.`);
    } else {
        console.log(`ℹ️ ${strTelegramId} disconnected one socket (${socket.id}) but still has ${remainingSocketsForUserInThisGame.length} other active sockets in game ${strGameId}. Unique player counts unchanged.`);
        // OLD LOGIC: Card release logic moved to the "if (remainingSocketsForUserInThisGame.length === 0)" block.
        // The card should only be released if the user has NO active connections left at all.
    }

    // Step 5: Recalculate and Broadcast ALL relevant player counts to ALL clients in the room.
    // This ensures consistency across all connected frontends.
    const numberOfPlayers = await redis.sCard(sessionKey) || 0; // Current count for lobby players
    // const playerCount = await redis.sCard(roomKey) || 0; // Current count for in-game players (when implemented)

    // Broadcast the updated lobby player count
    // Frontend uses `socket.on("gameid")` for this (your `count` state).
    io.to(strGameId).emit("gameid", {
        gameId: strGameId,
        numberOfPlayers,
    });
    // If you had an active `roomKey` for in-game players, you'd emit it like this:
    // io.to(strGameId).emit("playerCountUpdate", { gameId: strGameId, playerCount });

    console.log(`📊 Broadcasted counts for game ${strGameId}: numberOfPlayers (lobby)=${numberOfPlayers}`);

    // Step 6: Optional full game cleanup if no players are left
    // This part ensures that a game instance is fully reset if all participants leave.
    if (numberOfPlayers === 0 /* && playerCount === 0 */) { // Also consider playerCount if using it
        console.log(`🧹 No players left in game ${strGameId} (lobby count is 0). Triggering full game reset.`);

        // Update MongoDB GameControl to mark the game as inactive and clear related data
        await GameControl.findOneAndUpdate(
            { gameId: strGameId }, // Query by gameId
            {
                isActive: false,
                totalCards: 0,
                prizeAmount: 0,
                players: [], // Clear registered players for this game
                endedAt: new Date(),
            }
        );

        // Synchronize game active status (assuming this function updates Redis and possibly other states)
        await syncGameIsActive(strGameId, false);

        // Call your `resetGame` function to clear any remaining Redis data specific to the game
        // (e.g., gameCards, gameRooms if active, etc.)
        resetGame(strGameId, io, state, redis); // Ensure `resetGame` is defined and correctly imported/scoped
        console.log(`Game ${strGameId} has been reset due to no players.`);
    }
});


  });
};
