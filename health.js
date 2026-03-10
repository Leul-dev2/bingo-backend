// routes/health.js
// Register in index.js:
//   app.use("/health", require("./routes/health")(lazyRedisProxy, mongoose));
//
// Accepts either a real redis client OR a proxy object with a .ping() method,
// so the route works even before Redis is fully connected (reports "degraded").

const express = require("express");

module.exports = function healthRouter(redis, mongoose) {
    const router = express.Router();

    router.get("/", async (req, res) => {
        const checks = { redis: "unknown", mongo: "unknown" };
        let healthy  = true;

        // ── Redis ping ────────────────────────────────────────────────────────
        try {
            const pong    = await redis.ping();
            checks.redis  = (pong === "PONG" || pong === true) ? "ok" : "degraded";
        } catch (err) {
            checks.redis  = "not ready";
            healthy        = false;
        }

        // ── MongoDB readyState (1 = connected) ────────────────────────────────
        const mongoState = mongoose.connection.readyState;
        if (mongoState === 1) {
            checks.mongo = "ok";
        } else {
            checks.mongo = `degraded (state=${mongoState})`;
            healthy       = false;
        }

        res.status(healthy ? 200 : 503).json({
            status:    healthy ? "healthy" : "unhealthy",
            timestamp: new Date().toISOString(),
            checks,
        });
    });

    return router;
};
