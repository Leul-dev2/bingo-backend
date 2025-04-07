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

router.post("/start", async (req, res) => {
  const { gameId, telegramId } = req.body;

  try {
    // Ensure the 'await' keyword is used inside an 'async' function
    const user = await User.findOne({ telegramId });

    if (!user) return res.status(404).json({ error: "User not found" });

    if (user.balance < gameId) {
      return res.status(400).json({ error: "Insufficient balance" });
    }

    const io = req.app.get("io");

    io.emit("gameid", { gameId, telegramId });

  } catch (error) {
    console.error("Error starting the game:", error);
    res.status(500).json({ error: "Error starting the game" });
  }
});



module.exports = router;
