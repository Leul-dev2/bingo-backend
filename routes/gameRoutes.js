const express = require("express");
const router = express.Router();
const User = require("../models/User");
const Game = require("../models/Game");

// Error handler helper
const handleError = (res, error, message = "Server Error") => {
  console.error(message, error);
  res.status(500).json({ error: message });
};

// @route   POST /api/games/join
// @desc    User joins a game
// @access  Public or Authenticated based on your needs
router.post("/join", async (req, res) => {
  const { telegramId, gameId, betAmount } = req.body;

  try {
    const user = await User.findOne({ telegramId });
    if (!user) return res.status(404).json({ error: "User not found" });

    let game = await Game.findOne({ gameId });
    if (!game) return res.status(404).json({ error: "Game not found" });

    if (game.status === "ongoing")
      return res.status(400).json({ error: "Game already started" });

    if (user.balance < betAmount)
      return res.status(400).json({ error: "Insufficient balance" });

    if (game.players.includes(user._id))
      return res.status(400).json({ error: "Player already joined" });

    game.players.push(user._id);
    game.totalPrize += betAmount;

    const io = req.app.get("io"); // 👈 Get socket.io instance from Express

    if (game.players.length < 2) {
      await game.save();
      return res.json({
        message: "Waiting for more players...",
        gameId: game.gameId,
        gameStatus: game.status,
        players: game.players.length,
        totalPrize: game.totalPrize,
      });
    }

    user.balance -= betAmount;
    await user.save();

    game.status = "ongoing";
    await game.save();

    // 🔄 Real-time updates to all players in the game room
    io.to(game.gameId).emit("gameStatusUpdate", "ongoing");
    io.to(telegramId).emit("balanceUpdated", user.balance);

    res.json({
      message: "Joined game successfully",
      newBalance: user.balance,
      gameId: game.gameId,
      gameStatus: game.status,
      players: game.players.length,
      totalPrize: game.totalPrize,
    });

  } catch (error) {
    handleError(res, error, "Error joining game:");
  }
});

module.exports = router;
