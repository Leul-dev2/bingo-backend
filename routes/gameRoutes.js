const express = require('express');
const router = express.Router();
const User = require("../models/user");

const joiningUsers = new Set(); // In-memory lock to block rapid duplicate joins

// routes/start.js
router.post("/start", async (req, res) => {
  const { gameId, telegramId } = req.body;

  const joiningUsers = req.app.get("joiningUsers");
  const User = req.app.get("User");

  try {
    if (joiningUsers.has(telegramId)) {
      return res.status(429).json({ error: "You're already joining the game" });
    }

    joiningUsers.add(telegramId);

    const user = await User.findOneAndUpdate(
      { telegramId, balance: { $gte: gameId } },
      { $inc: { balance: -gameId } },
      { new: true }
    );

    if (!user) {
      joiningUsers.delete(telegramId);
      return res.status(400).json({ error: "Insufficient balance" });
    }

    joiningUsers.delete(telegramId);
    return res.status(200).json({ success: true, gameId, telegramId });

  } catch (err) {
    joiningUsers.delete(telegramId);
    return res.status(500).json({ error: "Internal server error" });
  }
});


module.exports = router;
