const User = require("../models/user");
const GameControl = require("../models/GameControl");
const GameHistory = require("../models/GameHistory")
const resetGame = require("../utils/resetGame");
const checkAndResetIfEmpty = require("../utils/checkandreset");
const redis = require("../utils/redisClient");
const  syncGameIsActive = require("../utils/syncGameIsActive");
const GameCard = require('../models/GameCard'); // Your Mongoose models



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
  socket.on("userJoinedGame", async ({ telegramId, gameId }) => {
  const strGameId = String(gameId);
  const strTelegramId = String(telegramId);
  const userSelectionKey = `userSelections`;

  try {
    // Add user to game session set
    await redis.sAdd(`gameSessions:${strGameId}`, strTelegramId);

    // Save user session by socket ID
    await redis.hSet(userSelectionKey, socket.id, JSON.stringify({
      telegramId: strTelegramId,
      gameId: strGameId
    }));

    // Join socket.io room
    socket.join(strGameId);

    // Send already selected cards to this user (from Redis hash)
    const cardSelections = await redis.hGetAll(`gameCards:${strGameId}`);
    if (cardSelections && Object.keys(cardSelections).length > 0) {
      socket.emit("currentCardSelections", cardSelections);
    }

    // Emit updated player count
    const numberOfPlayers = await redis.sCard(`gameSessions:${strGameId}`);
    io.to(strGameId).emit("gameid", { gameId: strGameId, numberOfPlayers });

    console.log(`✅ User ${strTelegramId} joined game room: ${strGameId}`);
  } catch (err) {
    console.error("❌ Redis error in userJoinedGame:", err);
    socket.emit("joinError", { message: "Failed to join game. Please try again." });
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

  // Clean card: replace "FREE" with 0 and cast all to Number
  const cleanCard = card.map(row => row.map(c => (c === "FREE" ? 0 : Number(c))));

  try {
    // 1️⃣ Acquire Redis lock for this card (10 seconds expiry)
    const lock = await redis.set(lockKey, strTelegramId, "NX", "EX", 30);
    if (!lock) {
      return socket.emit("cardError", { message: "⛔️ Someone else is picking this card. Try another." });
    }

    // 2️⃣ Atomically find and update or insert card document (upsert)
    let cardDoc;
    try {
      cardDoc = await GameCard.findOneAndUpdate(
  { gameId: strGameId, cardId: Number(strCardId) },
  {
    $set: {
      card: cleanCard,
      isTaken: true,
      takenBy: strTelegramId,
    }
  },
  { upsert: true, new: true }
);

    } catch (mongoErr) {
      if (mongoErr.code === 11000) {
        // Duplicate key error — someone else took it firs
        await redis.del(lockKey);
        return socket.emit("cardUnavailable", { cardId: strCardId });
      }
      throw mongoErr; // rethrow other errors
    }

    // 3️⃣ If card is taken by someone else, reject selection
    if (cardDoc.isTaken && cardDoc.takenBy !== strTelegramId) {
      await redis.del(lockKey);
      return socket.emit("cardUnavailable", { cardId: strCardId });
    }

    // 4️⃣ Check and release any previous card taken by this socket (if different)
    const previousSelectionRaw = await redis.hGet(userSelectionsKey, socket.id);
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

    // 5️⃣ Save current selection in Redis
    await redis.hSet(gameCardsKey, strCardId, strTelegramId);
    await redis.hSet(userSelectionsKey, socket.id, JSON.stringify({
      telegramId: strTelegramId,
      cardId: strCardId,
      card: cleanCard,
      gameId: strGameId,
    }));

    // 6️⃣ Emit confirmation and update events
    io.to(strTelegramId).emit("cardConfirmed", { cardId: strCardId, card: cleanCard });
    socket.to(strGameId).emit("otherCardSelected", { telegramId: strTelegramId, cardId: strCardId });

    // 7️⃣ Emit updated selections to everyone for UI sync
    const updatedSelections = await redis.hGetAll(gameCardsKey);
    io.to(strGameId).emit("currentCardSelections", updatedSelections);

    // 8️⃣ Emit current player count
    const numberOfPlayers = await redis.sCard(`gameSessions:${strGameId}`);
    io.to(strGameId).emit("gameid", { gameId: strGameId, numberOfPlayers });

    // 9️⃣ Release Redis lock
    await redis.del(lockKey);

    console.log(`✅ ${strTelegramId} selected card ${strCardId} in game ${strGameId}`);
  } catch (err) {
    await redis.del(lockKey);
    console.error("❌ cardSelected error:", err);
    socket.emit("cardError", { message: "Card selection failed." });
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
  // Use Redis keys to track running games to avoid conflicts
  const activeGameKey = `gameActive:${gameId}`;
  const countdownKey = `countdown:${gameId}`;
  const lockKey = `activeDrawLock:${gameId}`;
  console.log ("game count is called");
  try {
    // Check if game is already preparing or running via Redis keys
    const [isActive, hasCountdown, hasLock] = await Promise.all([
      redis.get(activeGameKey),
      redis.get(countdownKey),
      redis.get(lockKey),
    ]);

   console.log("console of ", isActive,  hasCountdown, hasLock);

    if (isActive || hasCountdown || hasLock) {
      console.log(`⚠️ Game ${gameId} is already preparing or running. Ignoring gameCount event.`);
      return;
    }

    // Mark game as active preparing
    await redis.set(activeGameKey, "true");

    // Prepare shuffled numbers and save to Redis
    const numbers = Array.from({ length: 75 }, (_, i) => i + 1).sort(() => Math.random() - 0.5);
    const gameDrawsKey = `gameDraws:${gameId}`;
    await redis.set(gameDrawsKey, JSON.stringify({ numbers, index: 0 }));

    // Create or update GameControl in DB
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

    // Countdown logic via Redis and setInterval
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

        // Fetch current player count from Redis
        const currentPlayers = await redis.sCard(`gameRooms:${gameId}`) || 0;
        const prizeAmount = stakeAmount * currentPlayers;

       if (currentPlayers === 0) {
            console.log("🛑 No players left. Stopping drawing...");
            
          }

        // Update GameControl DB
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

        // Mark game as active in Redis
        await redis.set(activeGameKey, "true");

        gameIsActive[gameId] = true;
        gameReadyToStart[gameId] = true;

        // Reset cards in Redis
        await redis.del(`gameCards:${gameId}`);

        io.to(gameId).emit("cardsReset", { gameId });
        io.to(gameId).emit("gameStart");

        startDrawing(gameId, io);
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
    ]);
  }
});





async function startDrawing(gameId, io) {
  console.log(`🎯 Starting the drawing process for gameId: ${gameId}`);

  const gameDrawsKey = `gameDraws:${gameId}`;
  const gameRoomsKey = `gameRooms:${gameId}`;
  const activeGameKey = `gameActive:${gameId}`;

  drawIntervals[gameId] = setInterval(async () => {
    try {
      // Fetch game draw state from Redis
      const gameDataRaw = await redis.get(gameDrawsKey);
      if (!gameDataRaw) {
        console.log(`❌ No game draw data found for ${gameId}, stopping draw.`);
        clearInterval(drawIntervals[gameId]);
        delete drawIntervals[gameId];
        return;
      }

      const game = JSON.parse(gameDataRaw);

      // Get current players count from Redis set cardinality
      const currentPlayers = await redis.sCard(gameRoomsKey) || 0;

      if (currentPlayers === 0) {
        console.log(`🛑 No players left in game ${gameId}. Stopping drawing...`);

        clearInterval(drawIntervals[gameId]);
        delete drawIntervals[gameId];

      resetGame(gameId, io, state, redis);

        // Update GameControl DB
        try {
          await GameControl.findOneAndUpdate(
            { gameId: gameId.toString() },
            { isActive: false }
          );
          await syncGameIsActive(gameId, false);
          console.log(`✅ GameControl updated: game ${gameId} set to inactive.`);
        } catch (err) {
          console.error(`❌ Failed to update GameControl for game ${gameId}:`, err);
        }

        io.to(gameId).emit("gameEnded");
        await redis.del(activeGameKey);
        await redis.del(gameDrawsKey);
        return;
      }

      // Check if all numbers drawn
      if (game.index >= game.numbers.length) {
        clearInterval(drawIntervals[gameId]);
        delete drawIntervals[gameId];

        io.to(gameId).emit("allNumbersDrawn");
        console.log(`🎯 All numbers drawn for game ${gameId}`);

        resetGame(gameId, io, state, redis)

        // Clean up Redis keys
        await redis.del(activeGameKey);
        await redis.del(gameDrawsKey);

        return;
      }

      // Draw next number
      const number = game.numbers[game.index];
      game.index += 1;

      // Save updated game draw state back to Redis
      await redis.set(gameDrawsKey, JSON.stringify(game));

      const letterIndex = Math.floor((number - 1) / 15);
      const letter = ["B", "I", "N", "G", "O"][letterIndex];
      const label = `${letter}-${number}`;

      console.log(`🔢 Drawing number: ${label}, Index: ${game.index - 1}`);

      io.to(gameId).emit("numberDrawn", { number, label });

    } catch (error) {
      console.error(`❌ Error during drawing interval for game ${gameId}:`, error);
      clearInterval(drawIntervals[gameId]);
      delete drawIntervals[gameId];
    }
  }, 3000); // Draw every 3 seconds
}





socket.on("winner", async ({ telegramId, gameId, board, winnerPattern, cartelaId }) => {
  try {
    const sessionId = gameSessionIds[gameId];
    if (!sessionId) {
      console.error(`❌ No session ID found for gameId ${gameId}`);
      return;
    }

    console.log(`🎯 Processing winner for gameId: ${gameId}, telegramId: ${telegramId}`);

    // Fetch game data from DB
    const gameData = await GameControl.findOne({ gameId: gameId.toString() });
    if (!gameData) {
      console.error(`❌ GameControl data not found for gameId: ${gameId}`);
      return;
    }

    const prizeAmount = gameData.prizeAmount;
    const stakeAmount = gameData.stakeAmount;
    const playerCount = gameData.totalCards;

    if (typeof prizeAmount !== "number" || isNaN(prizeAmount)) {
      console.error(`❌ Invalid or missing prizeAmount (${prizeAmount}) for gameId: ${gameId}`);
      return;
    }

    // Find winner user and update balance safely
    // Find winner user and update balance safely
      const winnerUser = await User.findOne({ telegramId });
      if (!winnerUser) {
      console.error(`❌ User with telegramId ${telegramId} not found`);
      return;
      }

      console.log(`🔍 Original winner balance: ${winnerUser.balance}`);
      winnerUser.balance = Number(winnerUser.balance || 0) + prizeAmount;
      await winnerUser.save();

      // **Update Redis cache with new balance**
      await redis.set(`userBalance:${telegramId}`, winnerUser.balance.toString());

      console.log(`🏆 ${winnerUser.username || "Unknown"} won ${prizeAmount}. New balance: ${winnerUser.balance}`);


    io.to(gameId.toString()).emit("winnerfound", {
      winnerName: winnerUser.username || "Unknown",
      prizeAmount,
      playerCount,
      board,
      winnerPattern,
      boardNumber: cartelaId,
      newBalance: winnerUser.balance,
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

    // Retrieve players from Redis set instead of in-memory gameRooms
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

    // Mark game inactive in DB
    await GameControl.findOneAndUpdate({ gameId: gameId.toString() }, { isActive: false });
    await syncGameIsActive(gameId, false);

    // Clear Redis keys related to this game
    await Promise.all([
      redis.del(`gameRooms:${gameId}`),
      redis.del(`gameCards:${gameId}`),
      redis.del(`gameDraws:${gameId}`),
      redis.del(`gameActive:${gameId}`),
      redis.del(`countdown:${gameId}`),
      redis.del(`activeDrawLock:${gameId}`),
    ]);

    resetGame(gameId, io, state, redis);
    io.to(gameId).emit("gameEnded");

  } catch (error) {
    console.error("🔥 Error processing winner:", error);
    socket.emit("winnerError", { message: "Failed to update winner balance. Please try again." });
  }
});


// ✅ Handle playerLeave event
socket.on("playerLeave", async ({ gameId, telegramId }, callback) => {
  try {
    console.log(`🚪 Player ${telegramId} is leaving game ${gameId}`);

    // Remove from Redis sets
    await Promise.all([
      redis.sRem(`gameSessions:${gameId}`, telegramId),
      redis.sRem(`gameRooms:${gameId}`, telegramId),
    ]);

    // Get userSelections from Redis hash "userSelections"
    const userSelectionRaw = await redis.hGet("userSelections", socket.id);
    let userSelection = userSelectionRaw ? JSON.parse(userSelectionRaw) : null;

    // Free selected card if owned by this player
    if (userSelection?.cardId) {
      const cardOwner = await redis.hGet(`gameCards:${gameId}`, userSelection.cardId);
      if (cardOwner === telegramId) {
        await redis.hDel(`gameCards:${gameId}`, userSelection.cardId);
        io.to(gameId).emit("cardAvailable", { cardId: userSelection.cardId });
      }
    }

    // Remove userSelections entry
    await redis.hDel("userSelections", socket.id);

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
socket.on("disconnect", async () => {
  console.log("🔴 Client disconnected");

  // Get user selection from Redis hash "userSelections"
  const userSelectionRaw = await redis.hGet("userSelections", socket.id);
  if (!userSelectionRaw) {
    console.log("❌ No user info found for this socket.");
    return;
  }

  const user = JSON.parse(userSelectionRaw);
  const { telegramId, gameId, cardId } = user;

  // Free up selected card if owned by this user (Redis hash commands)
  if (cardId) {
    const cardOwner = await redis.hGet(`gameCards:${gameId}`, cardId);
    if (cardOwner === telegramId) {
      await redis.hDel(`gameCards:${gameId}`, cardId);
      socket.to(gameId).emit("cardAvailable", { cardId });
      console.log(`✅ Card ${cardId} is now available again`);
    }
  }

  // Remove from Redis sets for sessions and rooms
  await Promise.all([
    redis.sRem(`gameSessions:${gameId}`, telegramId),
    redis.sRem(`gameRooms:${gameId}`, telegramId),
  ]);

  // Remove user selection entry from Redis hash
  await redis.hDel("userSelections", socket.id);

  // Emit updated player counts
  const playerCount = await redis.sCard(`gameRooms:${gameId}`) || 0;
  const numberOfPlayers = await redis.sCard(`gameSessions:${gameId}`) || 0;

  io.to(gameId).emit("playerCountUpdate", { gameId, playerCount });
  io.to(gameId).emit("gameid", { gameId, numberOfPlayers });

  // Reset game if empty
  if (playerCount === 0 && numberOfPlayers === 0) {
    console.log(`🧹 No players left in game ${gameId}. Triggering full game reset.`);

    try {
      await GameControl.findOneAndUpdate(
        { gameId: gameId.toString() },
        {
          isActive: false,
          totalCards: 0,
          prizeAmount: 0,
          players: [],
          endedAt: new Date(),
        }
      );
      await syncGameIsActive(gameId, false);
      console.log(`✅ GameControl for game ${gameId} set to inactive in DB.`);
    } catch (err) {
      console.error(`❌ Failed to update GameControl for ${gameId}:`, err);
    }

    resetGame(gameId, io, state, redis);
  }
});




  });
};
