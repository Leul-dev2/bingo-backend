const express = require('express');
const router = express.Router();
const { io, gameRooms } = require('../index');
const User = require("../models/user");

router.post("/start", async (req, res) => {
  const { gameId, telegramId } = req.body;

  const io = req.app.get("io"); // 👈 Access io
  const gameRooms = req.app.get("gameRooms"); // 👈 Access gameRooms

  try {
    const user = await User.findOne({ telegramId });
    if (!user) return res.status(404).json({ error: "User not found" });

    if (user.balance < gameId) {
      return res.status(400).json({ error: "Insufficient balance" });
    }

    user.balance -= gameId;
    await user.save();

    if (!gameRooms[gameId]) gameRooms[gameId] = [];
    if (!gameRooms[gameId].includes(telegramId)) {
      gameRooms[gameId].push(telegramId);
    }

    const playerCount = gameRooms[gameId].length;

    io.to(gameId).emit("playerCountUpdate", { gameId, playerCount });

    return res.status(200).json({ success: true, gameId, telegramId });

  } catch (error) {
    console.error("Error starting the game:", error);
    return res.status(500).json({ error: "Error starting the game" });
  }
});


module.exports = router;
