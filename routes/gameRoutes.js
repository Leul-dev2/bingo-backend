const express = require("express");
const router = express.Router();
const User = require("../models/user");
const Game = require("../models/game");
const { Socket } = require("socket.io");

// Error handler helper
const handleError = (res, error, message = "Server Error") => {
  console.error(message, error);
  res.status(500).json({ error: message });
};

// At the top of your file (outside the router), define gameSessions
const gameSessions = {}; // Stores gameId: [telegramIds]

router.post("/start", async (req, res) => {
  const { gameId, telegramId } = req.body;

  try {
    const user = await User.findOne({ telegramId });
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    if (user.balance < gameId) {
      return res.status(400).json({ error: "Insufficient balance" });
    }

    // Add user to the game session
    if (!gameSessions[gameId]) {
      gameSessions[gameId] = [];
    }

    // Avoid duplicates
    if (!gameSessions[gameId].includes(telegramId)) {
      gameSessions[gameId].push(telegramId);
    }

    // Emit game ID and updated player list to all clients in that game
    const io = req.app.get("io");
    io.emit("gameid", {
      gameId,
      telegramIds: gameSessions[gameId], // updated player list
      numberOfPlayers: gameSessions[gameId].length
    });

    return res.status(200).json({
      success: true,
      gameId,
      telegramId,
      playersInRoom: gameSessions[gameId],
    });

  } catch (error) {
    console.error("Error starting the game:", error);
    return res.status(500).json({ error: "Error starting the game" });
  }
});





module.exports = router;
