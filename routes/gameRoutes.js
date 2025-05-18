const express = require('express');
const router = express.Router();
const User = require("../models/user");

router.post("/start", async (req, res) => {
  const { gameId, telegramId } = req.body;

  const io = req.app.get("io");
  const gameRooms = req.app.get("gameRooms");

  try {
    // Ensure gameRooms object is ready
    if (!gameRooms[gameId]) {
      gameRooms[gameId] = [];
    }

    // Prevent multiple joins by checking if user is already in room
    if (gameRooms[gameId].includes(telegramId)) {
      return res.status(400).json({ error: "User already joined the game" });
    }

    // Atomically find user and deduct balance only if enough
    const user = await User.findOneAndUpdate(
      { telegramId, balance: { $gte: gameId } },
      { $inc: { balance: -gameId } },
      { new: true }
    );

    if (!user) {
      return res.status(400).json({ error: "User not found or insufficient balance" });
    }

    // Add user to game room
    gameRooms[gameId].push(telegramId);

    const playerCount = gameRooms[gameId].length;

    // Emit updates
    io.to(gameId).emit("playerCountUpdate", { gameId, playerCount });

    return res.status(200).json({ success: true, gameId, telegramId });

  } catch (error) {
    console.error("Error starting the game:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
});

module.exports = router;
