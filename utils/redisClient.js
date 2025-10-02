// redisClient.js
const { createClient } = require("redis");

const redisClient = createClient({
  url: process.env.REDIS_URL, // Upstash URL (rediss://)
  socket: {
    tls: true,                  // ✅ Enable TLS
    rejectUnauthorized: false,  // optional for Upstash
    reconnectStrategy: retries => Math.min(retries * 50, 2000), // automatic reconnect
  },
});

redisClient.on("error", (err) => {
  console.error("❌ Redis Client Error:", err);
});

(async () => {
  try {
    await redisClient.connect();
    console.log("✅ Redis connected");
  } catch (err) {
    console.error("❌ Redis connection failed:", err);
  }
})();

module.exports = redisClient;
