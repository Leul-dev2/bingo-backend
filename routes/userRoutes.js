const express = require("express");
const User = require("../models/user");

/**
 * User Routes Router Factory.
 * Accepts the pre-initialized Redis client for dependency injection.
 * @param {import('redis').RedisClientType} redisClient - The shared Redis client instance.
 * @returns {express.Router} The configured Express router.
 */
module.exports = (redisClient) => {
    const router = express.Router();

    router.get("/", (req, res) => {
        res.json({ message: "Users route is connected" });
    });

    /**
     * GET /getUser?telegramId=12345
     * Tries Redis first → falls back to DB → refreshes Redis if needed.
     */
    router.get("/getUser", async (req, res) => {
        const { telegramId } = req.query;
        const telegramIdNum = Number(telegramId);

        if (!telegramId) {
            return res.status(400).json({ error: "Missing telegramId" });
        }

        try {
            const cacheKey = `userBalance:${telegramId}`;
            const bonusCacheKey = `userBonusBalance:${telegramId}`;

            // 🔹 Try fetching from Redis first (fast path)
            const [cachedBalance, cachedBonus] = await Promise.all([
                redisClient.get(cacheKey),
                redisClient.get(bonusCacheKey),
            ]);

            if (cachedBalance !== null && cachedBonus !== null) {
                return res.json({
                    balance: Number(cachedBalance),
                    bonus_balance: Number(cachedBonus),
                    source: "redis",
                });
            }

            // 🔹 Fallback: Fetch from MongoDB if Redis cache is missing or expired
            const user = await User.findOne({ telegramId: telegramIdNum });
            if (!user) {
                return res.status(404).json({ error: "User not found" });
            }

            // 🔹 Update Redis cache (keep fresh for next time)
            await Promise.all([
                redisClient.set(cacheKey, user.balance, { EX: 60 }),
                redisClient.set(bonusCacheKey, user.bonus_balance, { EX: 60 }),
            ]);

            return res.json({
                balance: user.balance,
                bonus_balance: user.bonus_balance,
                source: "db (cached)",
            });

        } catch (error) {
            console.error("❌ Error fetching user data:", error);
            return res.status(500).json({ error: "Server error" });
        }
    });

    return router;
};
