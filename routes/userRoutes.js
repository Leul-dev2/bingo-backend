const express = require("express");
const User = require("../models/user");
const redis = require("../utils/redisClient"); // Import your Redis client
const router = express.Router();

router.get("/", (req, res) => {
  res.json({ message: "Users is connected" });
});

/**
 * GET /getUser?telegramId=12345[&refresh=true]
 * If refresh=true is passed, it fetches fresh data from DB and updates Redis.
 */
router.get("/getUser", async (req, res) => {
  const { telegramId, refresh } = req.query;
  console.log("user is have gotten here! 🚀🚀", req.query);

  if (!telegramId) {
    return res.status(400).json({ error: "Missing telegramId" });
  }

  try {
    const cacheKey = `userBalance:${telegramId}`;

    // If force refresh is passed, bypass Redis and fetch from DB
    if (refresh === "true") {
      const user = await User.findOne({ telegramId });
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      // Update cache with latest value
      await redis.set(cacheKey, user.balance, { EX: 60 });

      return res.json({ balance: user.balance, source: "refreshed-db" });
    }

    // Try to get balance from Redis
    const cachedBalance = await redis.get(cacheKey);
    if (cachedBalance !== null) {
      return res.json({ balance: Number(cachedBalance), source: "cache" });
    }

    // Not found in Redis, fallback to DB
    const user = await User.findOne({ telegramId });
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    // Cache it for future
    await redis.set(cacheKey, user.balance, { EX: 60 });

    return res.json({ balance: user.balance, source: "db" });
  } catch (error) {
    console.error("❌ Error fetching user data:", error);
    return res.status(500).json({ error: "Server error" });
  }
});

module.exports = router;
