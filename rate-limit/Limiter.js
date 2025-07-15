// rate-limit/historyLimiter.js
const { RateLimiterMemory } = require("rate-limiter-flexible");

const userRateLimiter = new RateLimiterMemory({
  keyPrefix: "hist_user",
  points: 5,          // 1 request
  duration: 1        // every 2 seconds
});

const globalRateLimiter = new RateLimiterMemory({
  keyPrefix: "hist_global",
  points: 200,        // 200 requests max
  duration: 1         // every 1 second
});

module.exports = {
  userRateLimiter,
  globalRateLimiter
};
