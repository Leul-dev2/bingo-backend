const express = require('express');
const router = express.Router();
const User = require("../models/user");

const joiningUsers = new Set(); // In-memory lock to block rapid duplicate joins

router.post("/start", async (req, res) => {
  const { gameId, telegramId } = req.body;

  const io = req.app.get("io");
  const gameRooms = req.app.get("gameRooms");

  try {
    // 🚫 Prevent double-clicking (fast repeated requests)
    if (joiningUsers.has(telegramId)) {
      return res.status(429).json({ error: "You're already joining the game" });
    }
    joiningUsers.add(telegramId);

    // ✅ Create game room if it doesn't exist
    if (!gameRooms[gameId]) {
      gameRooms[gameId] = [];
    }

    // 🚫 Don't let the same user join twice
    if (gameRooms[gameId].includes(telegramId)) {
      joiningUsers.delete(telegramId);
      return res.status(400).json({ error: "User already in the game" });
    }

    // ✅ Atomically deduct balance if user has enough
    const user = await User.findOneAndUpdate(
      { telegramId, balance: { $gte: gameId } },
      { $inc: { balance: -gameId } },
      { new: true }
    );

    if (!user) {
      joiningUsers.delete(telegramId);
      return res.status(400).json({ error: "Insufficient balance or user not found" });
    }

    // ✅ Add to game room
    gameRooms[gameId].push(telegramId);

    const playerCount = gameRooms[gameId].length;
    io.to(gameId).emit("playerCountUpdate", { gameId, playerCount });

    joiningUsers.delete(telegramId);
    return res.status(200).json({ success: true, gameId, telegramId });

  } catch (error) {
    console.error("Error:", error);
    joiningUsers.delete(telegramId);
    return res.status(500).json({ error: "Internal server error" });
  }
});

module.exports = router;
