const express = require("express");
const User = require("../models/user");
const redis = require("../utils/redisClient"); // Import your Redis client
const router = express.Router();

router.get("/", (req, res) => {
  res.json({ message: "Users is connected" });
});

router.get("/getUser", async (req, res) => {
  const { telegramId } = req.query;

  if (!telegramId) {
    return res.status(400).json({ error: "Missing telegramId" });
  }

  try {
    // Try to get cached balance from Redis
    const cacheKey = `userBalance:${telegramId}`;
    const cachedBalance = await redis.get(cacheKey);

    if (cachedBalance !== null) {
      // Return cached balance (string to number)
      return res.json({ balance: Number(cachedBalance), source: "cache" });
    }

    // If not cached, fetch from MongoDB
    const user = await User.findOne({ telegramId });
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    // Cache the balance in Redis for 60 seconds (or any TTL you prefer)
    await redis.set(cacheKey, user.balance, "EX", 60);

    return res.json({ balance: user.balance, source: "db" });
  } catch (error) {
    console.error("Error fetching user data:", error);
    return res.status(500).json({ error: "Server error" });
  }
});

module.exports = router;
