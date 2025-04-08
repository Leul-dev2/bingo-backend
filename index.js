const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const http = require("http");            // 👈 For raw HTTP server
const { Server } = require("socket.io"); // 👈 For socket.io
require("dotenv").config();

const userRoutes = require("./routes/userRoutes");
const gameRoutes = require("./routes/gameRoutes");

const app = express();
const server = http.createServer(app); // 👈 Create HTTP server
const io = new Server(server, {
  cors: {
    origin: "https://bossbingo.netlify.app", // Allow all origins — restrict in production
  },
});

// Middleware
app.use(express.json());
app.use(cors());

// Attach io to app to access inside routes
app.set("io", io);

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

io.on("connection", (socket) => {
  console.log("🟢 New client connected");

  // User joins a game
  socket.on("userJoinedGame", ({ telegramId, gameId }) => {
    // Initialize the game session if it doesn't exist
    if (!gameSessions[gameId]) {
      gameSessions[gameId] = [];  // Create a new array for game players if not already initialized
    }
  
    // Avoid duplicates in the game session
    if (!gameSessions[gameId].includes(telegramId)) {
      gameSessions[gameId].push(telegramId);  // Add the telegramId to the game session
    }
  
    // Add the user to the game room (to receive game-specific events)
    socket.join(gameId);
  
    // Store the gameId in the userSelections object for each user
    userSelections[socket.id] = { telegramId, gameId };  // Track by socket.id
    
    console.log(`User ${telegramId} joined game room: ${gameId}`);
    console.log(`User ${telegramId} added to game ${gameId}:`, gameSessions[gameId]);
  
    // Emit the number of players in the game session to all users in that game room
    const numberOfPlayers = gameSessions[gameId].length;  // This will be the number of players in the game
    io.to(gameId).emit("gameid", { gameId, numberOfPlayers });  // Send to everyone in the game room
  });

  // Other events like card selection
  socket.on("cardSelected", (data) => {
    const { telegramId, cardId, card, gameId } = data;

    // Store the selected card in the userSelections object
    userSelections[socket.id] = {
      ...userSelections[socket.id], // preserve existing data
      cardId,
      card,
      gameId, // Store the gameId as well
    };

    // Confirm to the sender only
    io.to(telegramId).emit("cardConfirmed", { cardId, card });

    // Notify others in the same game room (but not the sender)
    socket.to(gameId).emit("otherCardSelected", {
      telegramId,
      cardId,
    });

    console.log(`User ${telegramId} selected card ${cardId} in game ${gameId}`);

    // Emit the updated number of players in the game session after card selection
    const numberOfPlayers = gameSessions[gameId].length;  // Includes the current player
    console.log(`Number of players in game ${gameId}: ${numberOfPlayers}`);
    io.to(gameId).emit("gameid", { gameId, numberOfPlayers });
  });

  // Handle disconnection event
  socket.on("disconnect", () => {
    console.log("🔴 Client disconnected");
    
    const { telegramId, gameId } = userSelections[socket.id] || {};  // Get telegramId and gameId from userSelections
  
    if (telegramId && gameId) {
      // Remove the user from the game session
      gameSessions[gameId] = gameSessions[gameId].filter(id => id !== telegramId);
      delete userSelections[socket.id];  // Clean up the user from userSelections
  
      console.log(`User ${telegramId} disconnected from game ${gameId}`);
      console.log(`Updated game session ${gameId}:`, gameSessions[gameId]);
  
      // Emit the number of players in the game session after the player leaves
      const numberOfPlayers = gameSessions[gameId].length;
      io.to(gameId).emit("gameid", { gameId, numberOfPlayers });  // Send updated player count to everyone in the game room
    }
  });
});





// Start the server with WebSocket
const PORT = process.env.PORT || 5002;
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
