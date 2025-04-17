const express = require('express');
const router = express.Router();
const User = require("../models/user");
const Game = require("../models/game");

const {
  gameSessions,
  startedPlayers
} = require("../utils/gameState"); // Shared memory

// Error handler helper
const handleError = (res, error, message = "Server Error") => {
  console.error(message, error);
  res.status(500).json({ error: message });
};

// Start the game route
router.post("/start", async (req, res) => {
  const { gameId, telegramId } = req.body;
  const io = req.app.get("io"); // Access the existing io

  try {
    const user = await User.findOne({ telegramId });
    if (!user) return res.status(404).json({ error: "User not found" });

    // Check balance
    if (user.balance < gameId) {
      return res.status(400).json({ error: "Insufficient balance" });
    }

    // Deduct balance and save
    user.balance -= gameId;
    await user.save();

    // Add user to startedPlayers
    if (!startedPlayers[gameId]) startedPlayers[gameId] = [];
    if (!startedPlayers[gameId].includes(telegramId)) {
      startedPlayers[gameId].push(telegramId);
    }

    // Add user to game session
    if (!gameSessions[gameId]) gameSessions[gameId] = [];
    if (!gameSessions[gameId].includes(telegramId)) {
      gameSessions[gameId].push(telegramId);
    }

    // Notify all players in game room about update
    io.to(gameId).emit("playerCountUpdate", {
      gameId,
      playerCount: gameSessions[gameId].length,
    });

    io.to(gameId).emit("gameStarted", { gameId, telegramId });

    return res.status(200).json({ success: true, gameId, telegramId });

  } catch (error) {
    handleError(res, error, "Error starting the game");
  }
});

module.exports = router;
