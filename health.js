// health.js — Add this route to your Express app
// Usage:   app.use("/health", require("./routes/health")(redisClient, mongoose));
// Monitor: https://your-domain.com/health  (uptime robot, Railway health checks, etc.)

const express = require("express");

module.exports = function healthRouter(redis, mongoose) {
    const router = express.Router();

    router.get("/", async (req, res) => {
        const checks = { redis: "unknown", mongo: "unknown" };
        let healthy  = true;

        // ── Redis ping ────────────────────────────────────────────────────────
        try {
            const pong = await redis.ping();
            checks.redis = pong === "PONG" ? "ok" : "degraded";
        } catch (err) {
            checks.redis = "error";
            healthy      = false;
        }

        // ── MongoDB readyState ────────────────────────────────────────────────
        // 1 = connected, 2 = connecting, 3 = disconnecting, 0 = disconnected
        const mongoState = mongoose.connection.readyState;
        if (mongoState === 1) {
            checks.mongo = "ok";
        } else {
            checks.mongo = `degraded (state=${mongoState})`;
            healthy      = false;
        }

        const statusCode = healthy ? 200 : 503;

        res.status(statusCode).json({
            status:    healthy ? "healthy" : "unhealthy",
            timestamp: new Date().toISOString(),
            checks,
        });
    });

    return router;
};
