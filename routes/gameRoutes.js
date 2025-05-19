const express = require('express');
const router = express.Router();
const User = require("../models/user");
const Game = require("../models/game");

const joiningUsers = new Set();

router.post("/start", async (req, res) => {
  const { gameId, telegramId } = req.body;

  const io = req.app.get("io");
  const gameRooms = req.app.get("gameRooms");

  try {
    if (joiningUsers.has(telegramId)) {
      return res.status(429).json({ error: "You're already joining the game" });
    }
    joiningUsers.add(telegramId);

    // Check if game already exists in DB
    let game = await Game.findOne({ gameId });

    // If not, create a new game document
    if (!game) {
      game = new Game({
        gameId,
        entryFee: Number(gameId), // assuming gameId represents entryFee
        players: [],
        status: "active",
        prizePool: 0,
      });
      await game.save();
    }

    // Prevent joining again
    if (game.players.includes(telegramId)) {
      joiningUsers.delete(telegramId);
      return res.status(400).json({ error: "User already in the game" });
    }

    // Deduct balance if enough
    const user = await User.findOneAndUpdate(
      { telegramId, balance: { $gte: game.entryFee } },
      { $inc: { balance: -game.entryFee } },
      { new: true }
    );

    if (!user) {
      joiningUsers.delete(telegramId);
      return res.status(400).json({ error: "Insufficient balance or user not found" });
    }

    // Update game DB: add player + update prize pool
    game.players.push(telegramId);
    game.prizePool = game.players.length * game.entryFee;
    await game.save();

    // In-memory game room handling
    if (!gameRooms[gameId]) gameRooms[gameId] = [];
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
