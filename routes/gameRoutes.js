const express = require('express');
const router = express.Router();

const GameControl = require('../models/GameControl');
const User = require('../models/user');

// ✅ Game Start
router.post("/start", async (req, res) => {
  const { gameId, telegramId } = req.body;
  const joiningUsers = req.app.get("joiningUsers");
  const lockKey = `${gameId}:${telegramId}`;

  try {
    if (joiningUsers.has(lockKey)) {
      return res.status(429).json({ error: "You're already joining this game. Please wait." });
    }
    joiningUsers.add(lockKey);

    const game = await GameControl.findOne({ gameId });
    if (game?.isActive) {
      joiningUsers.delete(lockKey);
      return res.status(400).json({ error: "Game is already active." });
    }

    const user = await User.findOneAndUpdate(
      { telegramId, balance: { $gte: gameId } },
      { $inc: { balance: -gameId } },
      { new: true }
    );

    if (!user) {
      joiningUsers.delete(lockKey);
      return res.status(400).json({ error: "Insufficient balance." });
    }

    await GameControl.updateOne(
      { gameId },
      { $set: { isActive: true } },
      { upsert: true }
    );

    joiningUsers.delete(lockKey);
    return res.status(200).json({ success: true, gameId, telegramId });

  } catch (error) {
    console.error("Start game error:", error);
    joiningUsers.delete(lockKey);
    return res.status(500).json({ error: "Server error" });
  }
});

// ✅ Game Leave
router.post("/leave", async (req, res) => {
  const { gameId, telegramId } = req.body;
  const joiningUsers = req.app.get("joiningUsers");
  const lockKey = `${gameId}:${telegramId}`;

  if (joiningUsers.has(lockKey)) {
    joiningUsers.delete(lockKey);
    return res.json({ success: true, message: "Left the game successfully." });
  } else {
    return res.status(400).json({ success: false, message: "You are not in the game." });
  }
});

// ✅ Game Status Check
router.get('/:gameId/status/:telegramId', async (req, res) => {
  const { gameId, telegramId } = req.params;
  const joiningUsers = req.app.get("joiningUsers");
  const lockKey = `${gameId}:${telegramId}`;

  try {
    const game = await GameControl.findOne({ gameId });

    return res.json({
      gameExists: !!game,
      isActive: game?.isActive || false,
      isInGame: joiningUsers.has(lockKey)
    });
  } catch (error) {
    console.error("Status check error:", error);
    return res.status(500).json({ error: "Server error" });
  }
});

module.exports = router;
