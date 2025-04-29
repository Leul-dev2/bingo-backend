const express = require('express');
const router = express.Router();
const User = require("../models/user");

router.post("/start", async (req, res) => {
  const { gameId, telegramId } = req.body;

  const io = req.app.get("io"); // 👈 Access io
  const gameRooms = req.app.get("gameRooms"); // 👈 Access gameRooms

  try {
    // Check if the user exists
    const user = await User.findOne({ telegramId });
    if (!user) return res.status(404).json({ error: "User not found" });

    // Check if the user has enough balance to start the game
    if (user.balance < gameId) {
      return res.status(400).json({ error: "Insufficient balance" });
    }

    // Deduct the player's balance
    user.balance -= gameId;
    await user.save();

    // Ensure that the game room exists
    if (!gameRooms[gameId]) {
      gameRooms[gameId] = [];
    }

    // Only add the player if they aren't already in the game room
    if (!gameRooms[gameId].includes(telegramId)) {
      gameRooms[gameId].push(telegramId);
    }

    // Get the updated player count
    const playerCount = gameRooms[gameId].length;

    // Emit the updated player count to all clients in the game room
    io.to(gameId).emit("playerCountUpdate", { gameId, playerCount });
    
    // Emit the gameId and telegramId to notify clients
    io.to(gameId).emit("gameId", { gameId, telegramId });

    // Return success response
    return res.status(200).json({ success: true, gameId, telegramId });

  } catch (error) {
    console.error("Error starting the game:", error);
    return res.status(500).json({ error: "Error starting the game" });
  }
});

module.exports = router;
