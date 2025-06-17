const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const http = require("http");
const { Server } = require("socket.io");
require("dotenv").config();

const userRoutes = require("./routes/userRoutes");
const gameRoutes = require("./routes/gameRoutes");
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



    const makeCardAvailable = (gameId, cardId) => {
      if (gameCards[gameId]) {
        delete gameCards[gameId][cardId];  // Remove the card from the selected cards list
        console.log(`Card ${cardId} is now available in game ${gameId}`);
      }
    };



  const preventGameCountTrigger = {}; // Guards against race re-triggers

function resetGame(gameId, io) {
  console.log(`🧹 Starting reset for game ${gameId}`);

  gameIsActive[gameId] = false;

  if (drawIntervals[gameId]) {
    clearInterval(drawIntervals[gameId]);
    delete drawIntervals[gameId];
    console.log(`🛑 Cleared draw interval for ${gameId}`);
  }

  if (countdownIntervals[gameId]) {
    clearInterval(countdownIntervals[gameId]);
    delete countdownIntervals[gameId];
  }

  if (drawStartTimeouts[gameId]) {
    clearTimeout(drawStartTimeouts[gameId]);
    delete drawStartTimeouts[gameId];
  }

  delete activeDrawLocks[gameId];
  delete gameDraws[gameId];
  delete gameCards[gameId];
  delete gameSessionIds[gameId];
  delete gameSessions[gameId];
  delete gameRooms[gameId];
  gameReadyToStart[gameId] = false;

  for (let sid in userSelections) {
    if (userSelections[sid]?.gameId === gameId) {
      delete userSelections[sid];
    }
  }

  preventGameCountTrigger[gameId] = true;
  setTimeout(() => delete preventGameCountTrigger[gameId], 3000);

  io.to(gameId).emit("gameReset", { gameId });
  console.log(`🧼 Game ${gameId} fully reset.`);
}

function startDrawing(gameId, io) {
  console.log(`🚨 startDrawing for gameId: ${gameId} at ${new Date().toISOString()}`);
  if (activeDrawLocks[gameId] || drawStartTimeouts[gameId]) {
    console.log(`⚠️ Drawing in progress or pending for ${gameId}`);
    return;
  }

  drawStartTimeouts[gameId] = setTimeout(() => {
    delete drawStartTimeouts[gameId];
    if (!gameReadyToStart[gameId]) {
      console.log(`⛔ Game ${gameId} not ready yet.`);
      return;
    }

    const game = gameDraws[gameId];
    if (!game || game.index >= game.numbers.length) {
      console.log(`⚠️ No valid game to draw for ${gameId}`);
      return;
    }

    activeDrawLocks[gameId] = true;

    drawIntervals[gameId] = setInterval(() => {
      const g = gameDraws[gameId];
      if (!g || g.index >= g.numbers.length) {
        clearInterval(drawIntervals[gameId]);
        delete drawIntervals[gameId];
        delete activeDrawLocks[gameId];
        io.to(gameId).emit("allNumbersDrawn");
        console.log(`✅ All numbers drawn for ${gameId}`);
        resetGame(gameId, io);
        return;
      }

      const number = g.numbers[g.index++];
      const label = ["B", "I", "N", "G", "O"][Math.floor((number - 1) / 15)] + "-" + number;
      console.log(`🎲 ${gameId} drawing ${number} (${label})`);
      io.to(gameId).emit("numberDrawn", { number, label });
    }, 3000);
  }, 1000);
}

io.on("connection", (socket) => {
  console.log("🟢 New socket:", socket.id);

  socket.on("userJoinedGame", ({ telegramId, gameId }) => {
    if (!gameSessions[gameId]) gameSessions[gameId] = new Set();
    gameSessions[gameId].add(telegramId);
    socket.join(gameId);
    userSelections[socket.id] = { telegramId, gameId };

    if (gameCards[gameId]) {
      socket.emit("currentCardSelections", gameCards[gameId]);
    }

    io.to(gameId).emit("gameid", {
      gameId,
      numberOfPlayers: gameSessions[gameId].size,
    });
    console.log(`User ${telegramId} joined ${gameId}`);
  });

  socket.on("cardSelected", ({ telegramId, cardId, card, gameId }) => {
    if (!gameCards[gameId]) gameCards[gameId] = {};
    if (gameCards[gameId][cardId] && gameCards[gameId][cardId] !== telegramId) {
      io.to(telegramId).emit("cardUnavailable", { cardId });
      return;
    }

    const prev = userSelections[socket.id];
    const prevCard = prev?.cardId;
    if (prevCard && prevCard !== cardId) {
      delete gameCards[gameId][prevCard];
      socket.to(gameId).emit("cardAvailable", { cardId: prevCard });
    }

    gameCards[gameId][cardId] = telegramId;
    userSelections[socket.id] = { telegramId, cardId, card, gameId };

    io.to(telegramId).emit("cardConfirmed", { cardId, card });
    socket.to(gameId).emit("otherCardSelected", { telegramId, cardId });

    io.to(gameId).emit("gameid", {
      gameId,
      numberOfPlayers: gameSessions[gameId].size,
    });
    console.log(`Card ${cardId} secured by ${telegramId} in ${gameId}`);
  });

  socket.on("joinGame", ({ gameId, telegramId }) => {
    if (!gameRooms[gameId]) gameRooms[gameId] = new Set();
    gameRooms[gameId].add(telegramId);
    socket.join(gameId);

    io.to(gameId).emit("playerCountUpdate", {
      gameId,
      playerCount: gameRooms[gameId].size,
    });
    socket.emit("gameId", { gameId, telegramId });
  });

  socket.on("gameCount", async ({ gameId }) => {
    if (preventGameCountTrigger[gameId]) {
      console.log(`⛔ gameCount blocked for ${gameId}`);
      return;
    }

    if (!gameIsActive[gameId]) {
      console.log(`⛔ game ${gameId} inactive`);
      return;
    }

    if (gameDraws[gameId] || countdownIntervals[gameId] || activeDrawLocks[gameId]) {
      console.log(`⚠️ gameCount already running for ${gameId}`);
      return;
    }

    try {
      const existing = await GameControl.findOne({ gameId });
      const sessionId = uuidv4();
      gameSessionIds[gameId] = sessionId;
      const stakeAmount = Number(gameId);
      const totalCards = Object.keys(gameCards[gameId] || {}).length;

      if (!existing) {
        await GameControl.create({
          sessionId,
          gameId,
          stakeAmount,
          totalCards,
          isActive: true,
          createdBy: "system",
        });
      } else {
        existing.stakeAmount = stakeAmount;
        existing.totalCards = totalCards;
        existing.isActive = true;
        existing.createdAt = new Date();
        await existing.save();
      }

      await GameHistory.create({
        sessionId,
        gameId: gameId.toString(),
        username: "system",
        telegramId: "system",
        winAmount: 0,
        stake: stakeAmount,
        createdAt: new Date(),
      });

      const nums = Array.from({ length: 75 }, (_, i) => i + 1).sort(
        () => Math.random() - 0.5
      );
      gameDraws[gameId] = { numbers: nums, index: 0 };

      let countdown = 5;
      countdownIntervals[gameId] = setInterval(() => {
        if (countdown > 0) {
          io.to(gameId).emit("countdownTick", { countdown });
          countdown--;
        } else {
          clearInterval(countdownIntervals[gameId]);
          delete countdownIntervals[gameId];
          gameCards[gameId] = {};
          io.to(gameId).emit("cardsReset", { gameId });
          io.to(gameId).emit("gameStart");
          gameReadyToStart[gameId] = true;
          startDrawing(gameId, io);
        }
      }, 1000);
    } catch (err) {
      console.error("❌ gameCount error:", err);
    }
  });

  socket.on("winner", async ({ telegramId, gameId, board, winnerPattern, cartelaId }) => {
    try {
      const sessionId = gameSessionIds[gameId];
      const players = gameRooms[gameId] || new Set();
      const count = players.size;
      const stake = Number(gameId);
      const prize = stake * count;

      const user = await User.findOne({ telegramId });
      if (!user) throw new Error("User not found");
      user.balance += prize;
      await user.save();

      io.to(gameId).emit("winnerfound", {
        winnerName: user.username || "Unknown",
        prizeAmount: prize,
        playerCount: count,
        board,
        winnerPattern,
        boardNumber: cartelaId,
        newBalance: user.balance,
        telegramId,
        gameId,
      });

      await GameHistory.findOneAndUpdate(
        { sessionId },
        {
          gameId: gameId.toString(),
          username: user.username,
          telegramId,
          winAmount: prize,
          stake,
          createdAt: new Date(),
        }
      );
      await GameControl.findOneAndUpdate({ gameId }, { isActive: false });

      resetGame(gameId, io);
    } catch (err) {
      console.error("🔥 winner handling error:", err);
      socket.emit("winnerError", { message: "Winner processing failed." });
    }
  });

  socket.on("disconnect", () => {
    console.log("🔴 Socket disconnected:", socket.id);
    const u = userSelections[socket.id];
    if (!u) return;
    const { telegramId, gameId, cardId } = u;

    if (cardId && gameCards[gameId]?.[cardId] === telegramId) {
      delete gameCards[gameId][cardId];
      socket.to(gameId).emit("cardAvailable", { cardId });
    }

    gameSessions[gameId]?.delete(telegramId);
    gameRooms[gameId]?.delete(telegramId);
    delete userSelections[socket.id];

    io.to(gameId).emit("playerCountUpdate", {
      gameId,
      playerCount: gameRooms[gameId]?.size || 0,
    });
    io.to(gameId).emit("gameid", {
      gameId,
      numberOfPlayers: gameSessions[gameId]?.size || 0,
    });

    if (
      (gameSessions[gameId]?.size || 0) === 0 &&
      (gameRooms[gameId]?.size || 0) === 0
    ) {
      console.log(`🧹 All players left ${gameId}, resetting.`);
      resetGame(gameId, io);
    }
  });
});


// Start the server with WebSocket
const PORT = process.env.PORT || 5002;
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
