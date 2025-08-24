const redis = require("redis");

const redisClient = redis.createClient({
  socket: {
    host: process.env.REDIS_HOST,
    port: process.env.REDIS_PORT,
  },
  password: process.env.REDIS_PASSWORD,
});

redisClient.on("connect", () => console.log("✅ Redis client connected"));
redisClient.on("error", (err) => console.error("❌ Redis error:", err));

(async () => {
  await redisClient.connect();
})();

module.exports = redisClient;
