const express = require("express");
const User = require("../models/user");
const redis = require("../utils/redisClient");
const router = express.Router();

router.get("/", (req, res) => {
  res.json({ message: "Users is connected" });
});

/**
 * GET /getUser?telegramId=12345
 * Always fetch from DB, then update Redis.
 */
router.get("/getUser", async (req, res) => {
  const { telegramId } = req.query;
  const telegramIdNum = Number(telegramId);

  if (!telegramId) {
    return res.status(400).json({ error: "Missing telegramId" });
  }

  try {
    const cacheKey = `userBalance:${telegramId}`;
    const bonusCacheKey = `userBonusBalance:${telegramId}`; // New cache key for bonus balance

    // Always get fresh value from DB
    const user = await User.findOne({ telegramId: telegramIdNum });
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    // Update Redis to keep it consistent
    await redis.set(cacheKey, user.balance, { EX: 60 });
    await redis.set(bonusCacheKey, user.bonus_balance, { EX: 60 }); // Update bonus balance in Redis

    // Include both balances in the response
    return res.json({
      balance: user.balance,
      bonus_balance: user.bonus_balance,
      username: user.username,
      source: "db"
    });
  } catch (error) {
    console.error("❌ Error fetching user data:", error);
    return res.status(500).json({ error: "Server error" });
  }
});

module.exports = router;
