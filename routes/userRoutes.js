const express = require("express");
const User = require("../models/user");

module.exports = (redisClient) => {
    const router = express.Router();

    router.get("/", (req, res) => {
        res.json({ message: "Users route is connected" });
    });


    router.get("/getUser", async (req, res) => {
    const { telegramId } = req.query;
    const telegramIdNum = Number(telegramId);

    if (!telegramId) {
        return res.status(400).json({ error: "Missing telegramId" });
    }

    try {
        const cacheKey      = `userBalance:${telegramId}`;
        const bonusCacheKey = `userBonusBalance:${telegramId}`;
        const usernameCacheKey = `userUsername:${telegramId}`;

        const [cachedBalance, cachedBonus, cachedUsername] = await Promise.all([
            redisClient.get(cacheKey),
            redisClient.get(bonusCacheKey),
            redisClient.get(usernameCacheKey),
        ]);

        if (cachedBalance !== null && cachedBonus !== null) {
            return res.json({
                balance:       Number(cachedBalance),
                bonus_balance: Number(cachedBonus),
                username:      cachedUsername || null,
                source:        "redis",
            });
        }

        // Fallback to MongoDB
        const user = await User.findOne({ telegramId: telegramIdNum })
            .select("balance bonus_balance username")
            .lean();

        if (!user) {
            return res.status(404).json({ error: "User not found" });
        }

        // Cache all three values with 5 minute TTL
        await Promise.all([
            redisClient.set(cacheKey,         String(user.balance),       { EX: 300 }),
            redisClient.set(bonusCacheKey,     String(user.bonus_balance), { EX: 300 }),
            redisClient.set(usernameCacheKey,  String(user.username || ""), { EX: 300 }),
        ]);
        
        res.set("Cache-Control", "private, max-age=30");

        return res.json({
            balance:       user.balance,
            bonus_balance: user.bonus_balance,
            username:      user.username || null,
            source:        "db (cached)",
        });

    } catch (error) {
        console.error("❌ Error fetching user data:", error);
        return res.status(500).json({ error: "Server error" });
    }
});

    return router;
};
