const express = require("express");
const router = express.Router();
const User = require("../models/user");
const Game = require("../models/game");

// Error handler helper
const handleError = (res, error, message = "Server Error") => {
  console.error(message, error);
  res.status(500).json({ error: message });
};

router.post("/start", async (req, res) => {
  const { gameId, telegramId, betAmount } = req.body;

  try {
    // Ensure the 'await' keyword is used inside an 'async' function
    const user = await User.findOne({ telegramId });

    if (!user) return res.status(404).json({ error: "User not found" });

    if (user.balance < betAmount) {
      return res.status(400).json({ error: "Insufficient balance" });
    }

    let game = await Game.findOne({ gameId });
    if (!game) return res.status(404).json({ error: "Game not found" });

    const io = req.app.get("io");

    // Example: Create game room
    io.of("/").adapter.addClient(game.gameId, (err) => {
      if (err) {
        return res.status(500).json({ error: "Error creating game room" });
      }

      // Emit game status update to the room
      io.to(game.gameId).emit("gameStatusUpdate", "waiting");

      // Update user's balance
      // user.balance -= betAmount;
      // await user.save();  // This 'await' is allowed here as the function is 'async'

      res.json({
        message: "Game room created successfully",
        gameId: game.gameId,
        newBalance: user.balance,
      });
    });

  } catch (error) {
    console.error("Error starting the game:", error);
    res.status(500).json({ error: "Error starting the game" });
  }
});



module.exports = router;
