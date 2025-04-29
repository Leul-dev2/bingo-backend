const express = require('express');
const router = express.Router();
const User = require("../models/user");

router.post("/start", async (req, res) => {
  const { gameId, telegramId } = req.body;

  const io = req.app.get("io");
  const gameSessions = req.app.get("gameSessions"); // 👈 unify usage
  const gameStarted = req.app.get("gameStarted"); // 👈 track game status

  try {
    const user = await User.findOne({ telegramId });
    if (!user) return res.status(404).json({ error: "User not found" });

    if (user.balance < gameId) {
      return res.status(400).json({ error: "Insufficient balance" });
    }

    user.balance -= gameId;
    await user.save();

    // 👇 Use gameSessions consistently
    if (!gameSessions[gameId]) {
      gameSessions[gameId] = [];
    }

    if (!gameSessions[gameId].includes(telegramId)) {
      gameSessions[gameId].push(telegramId);
    }

    // Count players and broadcast
    const playerCount = gameSessions[gameId].length;

    io.to(gameId).emit("playerCountUpdate", { gameId, playerCount });
    io.to(gameId).emit("gameId", { gameId, telegramId });

    // 👇 Start the game if not already started
    if (playerCount >= 2 && !gameStarted[gameId]) {
      gameStarted[gameId] = true;
      io.to(gameId).emit("startGame");
      console.log(`🎮 Game started for room ${gameId}`);
    }

    return res.status(200).json({ success: true, gameId, telegramId });

  } catch (error) {
    console.error("Error starting the game:", error);
    return res.status(500).json({ error: "Error starting the game" });
  }
});


module.exports = router;
