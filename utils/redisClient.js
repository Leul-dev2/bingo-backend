// redisClient.js
const { createClient } = require("redis");

const redisClient = createClient({
  // You can optionally pass connection config here:
  // url: "redis://localhost:6379",
  // password: "yourpassword",
});

redisClient.on("error", (err) => {
  console.error("❌ Redis Client Error:", err);
});

redisClient.connect()
  .then(() => console.log("✅ Redis connected"))
  .catch((err) => console.error("❌ Redis connection failed:", err));

module.exports = redisClient;
