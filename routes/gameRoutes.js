const express = require('express');
const router = express.Router();
const User = require("../models/user");
const Game = require("../models/game");
const resetGame = req.app.get("resetGame");



const joiningUsers = new Set();

router.post("/start", async (req, res) => {
  const { gameId, telegramId } = req.body;

  const io = req.app.get("io");
  const gameRooms = req.app.get("gameRooms") || {};

  try {
    if (joiningUsers.has(telegramId)) {
      return res.status(429).json({ error: "You're already joining the game" });
    }
    joiningUsers.add(telegramId);

    // Check if game exists
    let game = await Game.findOne({ gameId });

    if (!game) {
      // Create new game with default entryFee=0 for now
      game = new Game({
        gameId,
        entryFee: 0,
        players: [],
        status: "active",
        prizePool: 0,
      });
      await game.save();
    }

    // Check if user already joined
    if (game.players.includes(telegramId)) {
      joiningUsers.delete(telegramId);
      return res.status(400).json({ error: "User already in the game" });
    }

    // Find user and check balance (assuming entryFee is zero, no deduction here)
    const user = await User.findOne({ telegramId });

    if (!user) {
      joiningUsers.delete(telegramId);
      return res.status(400).json({ error: "User not found" });
    }

    // Add player to game
    game.players.push(telegramId);
    game.prizePool = game.players.length * game.entryFee; // still zero now
    await game.save();

    // Update in-memory room
    if (!gameRooms[gameId]) gameRooms[gameId] = [];
    gameRooms[gameId].push(telegramId);
    req.app.set("gameRooms", gameRooms);

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


router.post("/complete", async (req, res) => {
  const resetGame = req.app.get("resetGame");
  const { gameId, winners = [], board, winnerPattern, cartelaId } = req.body;

  try {
    const gameRooms = req.app.get("gameRooms") || {};
    const players = gameRooms[gameId] || [];
    const playerCount = players.length;
    const stakeAmount = 0; // or however you calculate it
    const prizeAmount = stakeAmount * playerCount;

    const existingGame = await Game.findOne({ gameId });
    if (!existingGame) {
      return res.status(404).json({ error: "Game not found" });
    }
    if (existingGame.status === "completed") {
      return res.status(400).json({ error: "Game already completed" });
    }

    const updatedWinners = [];

    for (let telegramId of winners) {
      const user = await User.findOneAndUpdate(
        { telegramId },
        { $inc: { balance: prizeAmount } },
        { new: true }
      );
      if (user) {
        updatedWinners.push({ telegramId, username: user.username, newBalance: user.balance });
      }
    }

    const updatedGame = await Game.findOneAndUpdate(
      { gameId },
      {
        winners,
        playerCount,
        prizeAmount,
        winnerPattern,
        cartelaId,
        board,
        status: "completed",
        endedAt: new Date(),
      },
      { new: true }
    );

    // ✅ Get resetGame function from app
 
    if (typeof resetGame === "function") {
      resetGame(gameId);
    }

    return res.status(200).json({ success: true, updatedWinners, game: updatedGame });

  } catch (error) {
    console.error("Error completing game:", error);
    return res.status(500).json({ error: "Failed to complete game" });
  }
});


module.exports = router;
