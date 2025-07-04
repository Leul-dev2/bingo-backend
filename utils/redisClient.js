const Redis = require("redis");
const redisClient = Redis.createClient();

redisClient.connect()
  .then(() => console.log("✅ Redis connected"))
  .catch((err) => console.error("❌ Redis connection failed:", err));

module.exports = redisClient;
