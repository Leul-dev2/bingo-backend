const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const http = require("http");
const { Server } = require("socket.io");
require("dotenv").config();

const userRoutes = require("./routes/userRoutes");
const gameRoutes = require("./routes/gameRoutes");
const {
  gameSessions,
  userSelections,
  gameCards,
  startedPlayers
} = require("./utils/gameState");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "https://bossbingo.netlify.app", // or localhost for dev
  },
});

// Middleware
app.use(express.json());
app.use(cors());

// Attach io to app so you can use it in routes
app.set("io", io);

// Routes
app.use("/api/users", userRoutes);
app.use("/api/games", gameRoutes);

// Default route
app.get("/", (req, res) => {
  res.send("MERN Backend with Socket.IO is Running!");
});

// MongoDB Connection
mongoose
  .connect(process.env.MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(() => console.log("✅ MongoDB Connected"))
  .catch((err) => console.error("❌ MongoDB Connection Error:", err));

// Global error handler
app.use((err, req, res, next) => {
  console.error("🔥 Error Handler:", err.stack);
  res.status(500).json({ message: 'Something went wrong!' });
});

// Socket.IO Logic
const makeCardAvailable = (gameId, cardId) => {
  if (gameCards[gameId]) {
    delete gameCards[gameId][cardId];
    console.log(`Card ${cardId} is now available in game ${gameId}`);
  }
};

io.on("connection", (socket) => {
  console.log("🟢 New client connected");

  socket.on("userJoinedGame", ({ telegramId, gameId }) => {
    if (!gameSessions[gameId]) gameSessions[gameId] = [];
    if (!gameSessions[gameId].includes(telegramId)) {
      gameSessions[gameId].push(telegramId);
    }

    socket.join(gameId);
    userSelections[socket.id] = { telegramId, gameId };

    console.log(`User ${telegramId} joined game room: ${gameId}`);

    // Send current selected cards to this user
    if (gameCards[gameId]) {
      socket.emit("currentCardSelections", gameCards[gameId]);
    }

    // Send updated player count to all in room
    const numberOfPlayers = gameSessions[gameId].length;
    io.to(gameId).emit("gameid", { gameId, numberOfPlayers });
  });

  socket.on("cardSelected", (data) => {
    const { telegramId, cardId, card, gameId } = data;

    if (!gameCards[gameId]) {
      gameCards[gameId] = {};
    }

    // Check if card is taken
    if (gameCards[gameId][cardId] && gameCards[gameId][cardId] !== telegramId) {
      io.to(telegramId).emit("cardUnavailable", { cardId });
      console.log(`Card ${cardId} is already selected`);
      return;
    }

    // Free up old card
    const prevSelection = userSelections[socket.id];
    const prevCardId = prevSelection?.cardId;

    if (prevCardId && prevCardId !== cardId) {
      delete gameCards[gameId][prevCardId];
      socket.to(gameId).emit("cardAvailable", { cardId: prevCardId });
      console.log(`Card ${prevCardId} is now available again`);
    }

    // Save new card selection
    gameCards[gameId][cardId] = telegramId;
    userSelections[socket.id] = { telegramId, cardId, card, gameId };

    // Confirm to user and notify others
    io.to(telegramId).emit("cardConfirmed", { cardId, card });
    socket.to(gameId).emit("otherCardSelected", { telegramId, cardId });

    const numberOfPlayers = gameSessions[gameId]?.length || 0;
    io.to(gameId).emit("gameid", { gameId, numberOfPlayers });

    console.log(`User ${telegramId} selected card ${cardId} in game ${gameId}`);
  });

  socket.on("disconnect", () => {
    console.log("🔴 Client disconnected");

    const { telegramId, gameId, cardId } = userSelections[socket.id] || {};

    if (telegramId && gameId) {
      if (cardId && gameCards[gameId] && gameCards[gameId][cardId] === telegramId) {
        delete gameCards[gameId][cardId];
        socket.to(gameId).emit("cardAvailable", { cardId });
        console.log(`Card ${cardId} is now available again`);
      }

      gameSessions[gameId] = gameSessions[gameId]?.filter(id => id !== telegramId);
      delete userSelections[socket.id];

      console.log(`User ${telegramId} disconnected from game ${gameId}`);
      console.log(`Updated game session ${gameId}:`, gameSessions[gameId]);

      const numberOfPlayers = gameSessions[gameId]?.length || 0;
      io.to(gameId).emit("gameid", { gameId, numberOfPlayers });
    }
  });
});

// Start the server
const PORT = process.env.PORT || 5002;
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
