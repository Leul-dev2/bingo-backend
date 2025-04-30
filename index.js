const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const http = require("http");            // 👈 For raw HTTP server
const { Server } = require("socket.io"); // 👈 For socket.io
require("dotenv").config();


const userRoutes = require("./routes/userRoutes");
const gameRoutes = require("./routes/gameRoutes");
const User = require("./models/user");

const app = express();
const server = http.createServer(app); // 👈 Create HTTP server
const io = new Server(server, {
  cors: {
    origin: "https://bossbingo.netlify.app", // Allow all origins — restrict in production
    // origin: "http://localhost:5173",
  },
});

// Middleware
app.use(express.json());
app.use(cors());
let gameRooms = {};

// Attach io to app to access inside routes
app.set("io", io);
app.set("gameRooms", gameRooms);
// Attach the function to the app object so it's accessible in routes
app.set("emitPlayerCount", emitPlayerCount);

// Routes
app.use("/api/users", userRoutes);
app.use("/api/games", gameRoutes);

// Default route
app.get("/", (req, res) => {
  res.send("MERN Backend with Socket.IO is Running!");
});

// Connect to MongoDB
mongoose
  .connect(process.env.MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(() => console.log("✅ MongoDB Connected"))
  .catch((err) => console.error("❌ MongoDB Connection Error:", err));

// Global error handler
app.use((err, req, res, next) => {
  console.error("🔥 Error Handler:", err.stack);
  res.status(500).json({ message: 'Something went wrong!' });
});

// 🧠 Socket.IO Logic
// In-memory store (optional - for game logic)

let gameSessions = {}; // Store game sessions: gameId -> [telegramId]
let userSelections = {}; // Store user selections: socket.id -> { telegramId, gameId }
let gameCards = {}; // Store game card selections: gameId -> { cardId: telegramId }
const gameDraws = {}; // { [gameId]: { numbers: [...], index: 0 } };



const makeCardAvailable = (gameId, cardId) => {
  if (gameCards[gameId]) {
    delete gameCards[gameId][cardId];  // Remove the card from the selected cards list
    console.log(`Card ${cardId} is now available in game ${gameId}`);
  }
};



function emitPlayerCount(gameId) {
  const playerCount = gameRooms[gameId]?.length || 0;
  io.to(gameId).emit("playerCountUpdate", { gameId, playerCount });
}


const userSessions = {}; // To store user sessions globally

io.on("connection", (socket) => {
  console.log("🟢 New client connected");

  // When a user joins a game
  socket.on("userJoinedGame", ({ telegramId, gameId }) => {
    // If the game doesn't exist, create it
    if (!gameSessions[gameId]) {
      gameSessions[gameId] = [];
    }

    // If the player isn't already in the game, add them
    if (!gameSessions[gameId].includes(telegramId)) {
      gameSessions[gameId].push(telegramId);
    }

    socket.join(gameId);
    
    // Store session details: Track user and game session
    userSessions[socket.id] = { telegramId, gameId };

    console.log(`User ${telegramId} joined game room: ${gameId}`);

    // Send current selections or state
    if (gameCards[gameId]) {
      socket.emit("currentCardSelections", gameCards[gameId]);
    }

    // Notify everyone in the room
    const playerCount = gameSessions[gameId].length;
    io.to(gameId).emit("gameid", { gameId, playerCount });
  });

  // Handle player actions
  socket.on("cardSelected", (data) => {
    const { telegramId, cardId, card, gameId } = data;

    if (!gameCards[gameId]) {
      gameCards[gameId] = {}; // Ensure gameCards is initialized
    }

    // Check if the card is already selected
    if (gameCards[gameId][cardId] && gameCards[gameId][cardId] !== telegramId) {
      io.to(telegramId).emit("cardUnavailable", { cardId });
      console.log(`Card ${cardId} is already taken.`);
      return;
    }

    // Track the selected card
    gameCards[gameId][cardId] = telegramId;
    userSelections[socket.id] = { telegramId, cardId, card, gameId };

    // Notify the user and others about the card selection
    io.to(telegramId).emit("cardConfirmed", { cardId, card });
    socket.to(gameId).emit("otherCardSelected", { telegramId, cardId });

    // Update player count
    const numberOfPlayers = gameSessions[gameId].length;
    io.to(gameId).emit("gameid", { gameId, numberOfPlayers });

    console.log(`User ${telegramId} selected card ${cardId} in game ${gameId}`);
  });

  // Handle disconnections
  socket.on("disconnect", () => {
    console.log("🔴 Client disconnected");

    const session = userSessions[socket.id];
    if (session) {
      const { telegramId, gameId, cardId } = session;

      // Free up the card if the player was holding it
      if (cardId && gameCards[gameId] && gameCards[gameId][cardId] === telegramId) {
        delete gameCards[gameId][cardId];
        socket.to(gameId).emit("cardAvailable", { cardId });
        console.log(`Card ${cardId} is now available again`);
      }

      // Remove the player from the game session
      gameSessions[gameId] = gameSessions[gameId].filter(id => id !== telegramId);

      // Remove the player from the game room
      if (gameRooms[gameId]) {
        gameRooms[gameId] = gameRooms[gameId].filter(id => id !== telegramId);
      }

      // Clean up session data
      delete userSessions[socket.id];

      // Emit updated player count
      io.to(gameId).emit("gameid", { gameId, numberOfPlayers: gameSessions[gameId].length });
      io.to(gameId).emit("playerCountUpdate", { gameId, playerCount: gameSessions[gameId].length });
    }
  });
});


// Start the server with WebSocket
const PORT = process.env.PORT || 5002;
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
