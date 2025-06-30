const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const http = require("http");
const { Server } = require("socket.io");
require("dotenv").config();

const userRoutes = require("./routes/userRoutes");
const gameRoutes = require("./routes/gameRoutes");
const topPlayers=require('./routes/topPlayers')
const historyRoutes = require('./routes/history');
const walletRoute = require('./routes/wallet');
const profileRoutes = require('./routes/profile');



const User = require("./models/user");
const GameControl = require("./models/GameControl");
const GameHistory = require('./models/GameHistory');
const { v4: uuidv4 } = require("uuid");


const app = express();
const server = http.createServer(app);


// ⚙️ Setup Socket.IO with CORS
const io = new Server(server, {
  cors: {
    origin: "*", // Change to specific frontend domain in production
    methods: ["GET", "POST"],
  },
});

// 🔐 In-memory shared objects
const gameRooms = {};
const joiningUsers = new Set();

// 📌 Attach shared objects to app for route access
app.set("io", io);
app.set("gameRooms", gameRooms);
app.set("joiningUsers", joiningUsers);
app.set("User", User);

// 🌐 Middleware
app.use(express.json());
app.use(cors());

// 🚏 Routes
app.use("/api/users", userRoutes);
app.use("/api/games", gameRoutes);
app.use("/api/Score", topPlayers); 
app.use('/api/history', historyRoutes);
app.use('/api/wallet', walletRoute);
app.use('/api/profile', profileRoutes);



// 🏠 Default route
app.get("/", (req, res) => {
  res.send("MERN Backend with Socket.IO is Running!");
});

// 🌍 MongoDB Connection
mongoose
  .connect(process.env.MONGO_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
  })
  .then(() => console.log("✅ MongoDB Connected"))
  .catch((err) => console.error("❌ MongoDB Connection Error:", err));

// 🛑 Global error handler
app.use((err, req, res, next) => {
  console.error("🔥 Error Handler:", err.stack);
  res.status(500).json({ message: "Something went wrong!" });
});


// 🧠 Socket.IO Logic
// In-memory store (optional - for game logic)

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



    const makeCardAvailable = (gameId, cardId) => {
      if (gameCards[gameId]) {
        delete gameCards[gameId][cardId];  // Remove the card from the selected cards list
        console.log(`Card ${cardId} is now available in game ${gameId}`);
      }
    };


// ✅ Helper function to check if the game should be resetS
  function checkAndResetIfEmpty(gameId, io) {
  // Use optional chaining ?.size and fallback to 0 if undefined
  const sessionSize = gameSessions[gameId]?.size ?? 0;
  const roomSize = gameRooms[gameId]?.size ?? 0;

  console.log("room size", roomSize);
   console.log("session size", sessionSize);

  if (sessionSize === 0 && roomSize === 0) {
    console.log(`🧹 No players left in game ${gameId}. Resetting game...`);
    resetGame(gameId, io);

    GameControl.findOneAndUpdate(
      { gameId },
      { isActive: false }
    ).catch(err => console.error("❌ Error updating game status:", err));

    io.to(gameId).emit("gameEnded");
    return true;
  } else {
    console.log(`🟢 Game ${gameId} continues with ${roomSize} players.`);
    return false;
  }
}




  async function resetGame(gameId, io) {
  console.log(`🧹 Starting reset for game ${gameId}`);

  // 🔥 Reset GameControl in MongoDB
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
    console.log(`✅ GameControl for game ${gameId} has been reset in DB.`);
  } catch (err) {
    console.error(`❌ Failed to reset GameControl for ${gameId}:`, err);
  }

  // 🔥 Notify clients the game has ended
  io?.to(gameId).emit("gameEnded");

  // ✅ Clear drawing interval
  if (drawIntervals[gameId]) {
    clearInterval(drawIntervals[gameId]);
    delete drawIntervals[gameId];
    console.log(`🛑 Cleared draw interval for gameId: ${gameId}`);
  }

  // ✅ Clear countdown interval
  if (countdownIntervals[gameId]) {
    clearInterval(countdownIntervals[gameId]);
    delete countdownIntervals[gameId];
  }

  // ✅ Clear pending draw start
  if (drawStartTimeouts[gameId]) {
    clearTimeout(drawStartTimeouts[gameId]);
    delete drawStartTimeouts[gameId];
  }

  // ✅ Remove in-memory game state
  delete activeDrawLocks[gameId];
  delete gameDraws[gameId];
  delete gameCards[gameId];
  delete gameSessionIds[gameId];
  delete gameSessions[gameId];
  delete gameRooms[gameId];
  delete gameIsActive[gameId];
  delete gamePlayers[gameId];

  // ✅ Remove user selections for this game
  for (let socketId in userSelections) {
    if (userSelections[socketId]?.gameId === gameId) {
      delete userSelections[socketId];
    }
  }

  console.log(`🧼 Game ${gameId} has been fully reset.`);
}




io.on("connection", (socket) => {
      console.log("🟢 New client connected");
      console.log("Client connected with socket ID:", socket.id);
      // User joins a game
      socket.on("userJoinedGame", ({ telegramId, gameId }) => {
  // if (!gameRooms[gameId] || !gameRooms[gameId].has(telegramId)) {
  //   console.warn(`🚫 Blocked unpaid user ${telegramId} from joining game session ${gameId}`);
  //   return;
  // }

  if (!gameSessions[gameId]) {
    gameSessions[gameId] = new Set();
  }

  gameSessions[gameId].add(telegramId);
  socket.join(gameId);

  userSelections[socket.id] = { telegramId, gameId };

  // Send current selected cards
  if (gameCards[gameId]) {
    socket.emit("currentCardSelections", gameCards[gameId]);
  }

  // Emit current player count
  const numberOfPlayers = gameSessions[gameId]?.size || 0;
  io.to(gameId).emit("gameid", { gameId, numberOfPlayers });

  console.log(`User ${telegramId} joined game room: ${gameId}`);
      });



     socket.on("cardSelected", (data) => {
      const { telegramId, cardId, card, gameId } = data;

      // ✅ Only allow if user paid (is in gameRooms)
      // if (!gameRooms[gameId] || !gameRooms[gameId].has(telegramId)) {
      //   console.warn(`🚫 Blocked unpaid user ${telegramId} from selecting card in game ${gameId}`);
      //   return;
      // }

      if (!gameCards[gameId]) {
        gameCards[gameId] = {};
      }

      if (gameCards[gameId][cardId] && gameCards[gameId][cardId] !== telegramId) {
        io.to(telegramId).emit("cardUnavailable", { cardId });
        return;
      }

      const prevSelection = userSelections[socket.id];
      const prevCardId = prevSelection?.cardId;

      if (prevCardId && prevCardId !== cardId) {
        delete gameCards[gameId][prevCardId];
        socket.to(gameId).emit("cardAvailable", { cardId: prevCardId });
      }

      gameCards[gameId][cardId] = telegramId;
      userSelections[socket.id] = { telegramId, cardId, card, gameId };

      io.to(telegramId).emit("cardConfirmed", { cardId, card });
      socket.to(gameId).emit("otherCardSelected", { telegramId, cardId });

      const numberOfPlayers = gameSessions[gameId]?.size || 0;
      io.to(gameId).emit("gameid", { gameId, numberOfPlayers });

      console.log(`User ${telegramId} selected card ${cardId} in game ${gameId}`);
    });




        socket.on("joinGame", async ({ gameId, telegramId }) => {
         const game = await GameControl.findOne({ gameId });

        if (!game || !game.players.includes(telegramId)) {
          console.warn(`🚫 Blocked unpaid user ${telegramId} from joining game ${gameId}`);
          socket.emit("joinError", { message: "You are not registered in this game." });
          return;
        }

      if (!gameRooms[gameId]) gameRooms[gameId] = new Set();
      gameRooms[gameId].add(telegramId);

      socket.join(gameId);

      io.to(gameId).emit("playerCountUpdate", {
          gameId,
          playerCount: gameRooms[gameId].size,
      });

      socket.emit("gameId", { gameId, telegramId });
      });



      // socket.on("getPlayerCount", ({ gameId }) => {
        
      //     const playerCount = gameRooms[gameId]?.length || 0;
      //     socket.emit("playerCountUpdate", { gameId, playerCount });
      // });



socket.on("gameCount", async ({ gameId }) => {
  if (gameDraws[gameId] || countdownIntervals[gameId] || activeDrawLocks[gameId]) {
    console.log(`⚠️ Game ${gameId} is already preparing or running. Ignoring gameCount event.`);
    return;
  }

  gameDraws[gameId] = { numbers: [], index: 0 };

  try {
    const existing = await GameControl.findOne({ gameId });
    const sessionId = uuidv4();
    gameSessionIds[gameId] = sessionId;
    const stakeAmount = Number(gameId); // ⚠️ Ideally from config

    if (!existing) {
      await GameControl.create({
        sessionId,
        gameId,
        stakeAmount,
        totalCards: 0, // Placeholder
        prizeAmount: 0, // Placeholder
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

    const numbers = Array.from({ length: 75 }, (_, i) => i + 1).sort(() => Math.random() - 0.5);
    gameDraws[gameId].numbers = numbers;

    // ⏱️ Countdown
    let countdownValue = 5;
    countdownIntervals[gameId] = setInterval(async () => {
      if (countdownValue > 0) {
        io.to(gameId).emit("countdownTick", { countdown: countdownValue });
        countdownValue--;
      } else {
        clearInterval(countdownIntervals[gameId]);

        // ✅ UPDATE player count and prize at this moment
        const currentPlayers = gameRooms[gameId]?.size || 0;
        const prizeAmount = stakeAmount * currentPlayers;

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

        console.log(`✅ Game ${gameId} is now ACTIVE with ${currentPlayers} players.`);

        gameIsActive[gameId] = true;
        gameReadyToStart[gameId] = true;

        gameCards[gameId] = {};
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
  }
});




  async function startDrawing(gameId, io) {
  console.log(`🎯 Starting the drawing process for gameId: ${gameId}`);

  drawIntervals[gameId] = setInterval(async () => {
    const game = gameDraws[gameId];

    const currentPlayers = gameRooms[gameId]?.size ?? 0;
    if (currentPlayers === 0) {
      console.log(`🛑 No players left in game ${gameId}. Stopping drawing...`);

      clearInterval(drawIntervals[gameId]);
      delete drawIntervals[gameId];

      resetGame(gameId, io);

      try {
        await GameControl.findOneAndUpdate(
          { gameId: gameId.toString() },
          { isActive: false }
        );
        console.log(`✅ GameControl updated: game ${gameId} set to inactive.`);
      } catch (err) {
        console.error(`❌ Failed to update GameControl for game ${gameId}:`, err);
      }

      io.to(gameId).emit("gameEnded");
      return;
    }

    // ✔️ Check if game has valid numbers to draw
    if (!game || game.index >= game.numbers.length) {
      clearInterval(drawIntervals[gameId]);
      delete drawIntervals[gameId];

      io.to(gameId).emit("allNumbersDrawn");
      console.log(`🎯 All numbers drawn for game ${gameId}`);

      // Optional: reset game after all numbers drawn
      resetGame(gameId, io);

      return;
    }

    // ✔️ Draw one number
    const number = game.numbers[game.index++];
    const letterIndex = Math.floor((number - 1) / 15);
    const letter = ["B", "I", "N", "G", "O"][letterIndex];
    const label = `${letter}-${number}`;

    console.log(`🔢 Drawing number: ${label}, Index: ${game.index - 1}`);

    io.to(gameId).emit("numberDrawn", { number, label });

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

    // Ensure gameId is string to match DB
    const gameData = await GameControl.findOne({ gameId: gameId.toString() });

    if (!gameData) {
      console.error(`❌ GameControl data not found for gameId: ${gameId}`);
      return;
    }

    console.log("🔍 Fetched gameData:", gameData);

    const prizeAmount = gameData.prizeAmount;
    const stakeAmount = gameData.stakeAmount;
    const playerCount = gameData.totalCards;

    if (typeof prizeAmount !== "number" || isNaN(prizeAmount)) {
      console.error(`❌ Invalid or missing prizeAmount (${prizeAmount}) for gameId: ${gameId}`);
      return;
    }

    const winnerUser = await User.findOne({ telegramId });
    if (!winnerUser) {
      console.error(`❌ User with telegramId ${telegramId} not found`);
      return;
    }

    console.log(`🔍 Original winner balance: ${winnerUser.balance}`);

    // Safely update balance
    winnerUser.balance = Number(winnerUser.balance || 0) + prizeAmount;
    await winnerUser.save();

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

    const players = gameRooms[gameId] || new Set();
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
    resetGame(gameId, io);
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

    // Remove from sessions and rooms
    if (gameSessions[gameId]) gameSessions[gameId].delete(telegramId);
    if (gameRooms[gameId]) gameRooms[gameId].delete(telegramId);

    // Free selected card
    const user = Object.values(userSelections).find(
      (u) => u.telegramId === telegramId && u.gameId === gameId
    );
    if (user?.cardId && gameCards[gameId]?.[user.cardId] === telegramId) {
      delete gameCards[gameId][user.cardId];
      io.to(gameId).emit("cardAvailable", { cardId: user.cardId });
    }

    // Clean userSelections for this player
    for (const [key, value] of Object.entries(userSelections)) {
      if (value.telegramId === telegramId && value.gameId === gameId) {
        delete userSelections[key];
      }
    }

    // Emit updated player count
    io.to(gameId).emit("playerCountUpdate", {
      gameId,
      playerCount: gameRooms[gameId]?.size || 0,
    });

    io.to(gameId).emit("gameid", {
      gameId,
      numberOfPlayers: gameSessions[gameId]?.size || 0,
    });

    // Check if game needs to reset
    checkAndResetIfEmpty(gameId, io);

    // Inform client that leave was successful
    if (callback) callback();
  } catch (error) {
    console.error("❌ Error handling playerLeave:", error);
    if (callback) callback();
  }
});


      // Handle disconnection events
  socket.on("disconnect", async () => {
  console.log("🔴 Client disconnected");

  const user = userSelections[socket.id];
  if (!user) {
    console.log("❌ No user info found for this socket.");
    return;
  }

  const { telegramId, gameId, cardId } = user;

  // 🃏 Free up the selected card
  if (cardId && gameCards[gameId]?.[cardId] === telegramId) {
    delete gameCards[gameId][cardId];
    socket.to(gameId).emit("cardAvailable", { cardId });
    console.log(`✅ Card ${cardId} is now available again`);
  }

  // 🧹 Remove from gameSessions
  if (gameSessions[gameId] instanceof Set) {
    gameSessions[gameId].delete(telegramId);
    console.log(`Updated gameSessions for ${gameId}:`, [...gameSessions[gameId]]);
  }

  // 🧹 Remove from gameRooms
  if (gameRooms[gameId] instanceof Set) {
    gameRooms[gameId].delete(telegramId);
    console.log(`Updated gameRooms for ${gameId}:`, [...gameRooms[gameId]]);
  }

  // 🧼 Clean userSelections
  delete userSelections[socket.id];

  // 📢 Emit updated player count
  io.to(gameId).emit("playerCountUpdate", {
    gameId,
    playerCount: gameRooms[gameId]?.size || 0,
  });

  io.to(gameId).emit("gameid", {
    gameId,
    numberOfPlayers: gameSessions[gameId]?.size || 0,
  });

  // 🧨 If no players left, reset game + DB
  const currentSessionPlayers = gameSessions[gameId]?.size || 0;
  const currentRoomPlayers = gameRooms[gameId]?.size || 0;

  if (currentSessionPlayers === 0 && currentRoomPlayers === 0) {
    console.log(`🧹 No players left in game ${gameId}. Triggering full game reset.`);

    // ✅ Update GameControl in MongoDB
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
      console.log(`✅ GameControl for game ${gameId} set to inactive in DB.`);
    } catch (err) {
      console.error(`❌ Failed to update GameControl for ${gameId}:`, err);
    }

    resetGame(gameId, io); // This emits "gameEnded"
  }
});




  });

// Start the server with WebSocket
const PORT = process.env.PORT || 5002;
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
