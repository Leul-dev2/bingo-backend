const express = require('express');
const router = express.Router();
const { io } = require('../index'); // Access 'io' directly from index.js // Access the existing io from the index.js
const User = require("../models/user");
const Game = require("../models/game");

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
  const io = req.app.get("io"); // Get io from app

  try {
    const user = await User.findOne({ telegramId });
    if (!user) return res.status(404).json({ error: "User not found" });

    if (user.balance < gameId) {
      return res.status(400).json({ error: "Insufficient balance" });
    }

    user.balance -= gameId;
    await user.save();

    // Add user to game room (use shared gameRooms object)
    if (!gameRooms[gameId]) gameRooms[gameId] = [];
    if (!gameRooms[gameId].includes(telegramId)) {
      gameRooms[gameId].push(telegramId);
    }

    const playerCount = gameRooms[gameId].length;
    // Notify clients in the game room
    socket.on("getPlayerCount", (gameId) => {
    const playerCount = gameRooms[gameId]?.length || 0;
    socket.emit("playerCountUpdate", { gameId, playerCount });
    });


    io.to(gameId).emit("gameId", { gameId, telegramId });

    return res.status(200).json({ success: true, gameId, telegramId });

  } catch (error) {
    console.error("Error starting the game:", error);
    return res.status(500).json({ error: "Error starting the game" });
  }
});

module.exports = router;
