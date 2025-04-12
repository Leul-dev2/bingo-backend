const express = require("express");
const router = express.Router();
const User = require("../models/user");
const Game = require("../models/game");
const { Socket } = require("socket.io");

// In-memory storage for players in each game room
let gameRooms = {};  // Key: gameId, Value: array of player telegramIds

// Error handler helper
const handleError = (res, error, message = "Server Error") => {
  console.error(message, error);
  res.status(500).json({ error: message });
};

// Start the game route
router.post("/start", async (req, res) => {
  const { gameId, telegramId } = req.body;

  try {
    // Find the user based on the telegramId
    const user = await User.findOne({ telegramId });
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    // Check if the user has sufficient balance to start the game
    if (user.balance < gameId) {
      return res.status(400).json({ error: "Insufficient balance" });
    }

    // Reduce the user's balance if needed (optional step)
    user.balance -= gameId; // Subtract the game cost (assuming the gameId represents the cost)
    await user.save(); // Save the new balance

    // Add player to the game room
    if (!gameRooms[gameId]) {
      gameRooms[gameId] = []; // Initialize the game room if it doesn't exist
    }
    
    // Add the player to the game room (track player by telegramId)
    gameRooms[gameId].push(telegramId);

    // Emit the updated player count to the game room
    const io = req.app.get("io");
    io.to(gameId).emit("playerCountUpdate", {
      gameId,
      playerCount: gameRooms[gameId].length,
    });

    // Emit the game ID to the client
    io.to(gameId).emit("gameId", { gameId, telegramId });

    // Send a successful response back to the client
    return res.status(200).json({ success: true, gameId, telegramId });

  } catch (error) {
    console.error("Error starting the game:", error);
    return res.status(500).json({ error: "Error starting the game" });
  }
});

// Socket.IO connection event for players joining the game room
const io = require('socket.io')(Server); // Make sure the server object is passed here

io.on("connection", (socket) => {
  socket.on("joinGame", (gameId, telegramId) => {
    // Add the player to the room
    socket.join(gameId); // Join the room using gameId
    console.log(`${telegramId} joined game room ${gameId}`);

    // Send the initial player count when a new player joins
    const playerCount = gameRooms[gameId] ? gameRooms[gameId].length : 0;
    socket.emit("playerCountUpdate", { gameId, playerCount });

    // Emit to all players in the room about the new player
    io.to(gameId).emit("playerCountUpdate", {
      gameId,
      playerCount: gameRooms[gameId].length,
    });
  });

  socket.on("disconnect", () => {
    // Handle player disconnecting and update room count if needed
    // Cleanup logic when players leave, if necessary
  });
});

module.exports = router;
