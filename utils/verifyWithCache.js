const { verifyTelegramInitData } = require("./verifyTelegram");

async function verifyTelegramWithCache(initDataRaw, botToken, redis) {
  // Extract telegramId first (without verifying)
  const params = new URLSearchParams(initDataRaw);
  const userRaw = params.get("user");

  if (!userRaw) return null;

  const { id } = JSON.parse(userRaw);
  const cacheKey = `tg:user:${id}`;

  // 1️⃣ CHECK CACHE FIRST
  const cached = await redis.get(cacheKey);

  if (cached) {
    console.log("✅ User loaded from Redis cache");
    return JSON.parse(cached);
  }

  // 2️⃣ VERIFY CRYPTOGRAPHICALLY
  const verifiedUser = verifyTelegramInitData(initDataRaw, botToken);

  if (!verifiedUser) return null;

  // 3️⃣ STORE MINIMAL DATA
  const minimalUser = {
    telegramId: verifiedUser.telegramId,
    username: verifiedUser.username,
    first_name: verifiedUser.first_name,
  };

  // 4️⃣ CACHE with TTL (VERY IMPORTANT)
  await redis.set(
    cacheKey,
    JSON.stringify(minimalUser),
    "EX",
    3600 // 1 hour
  );

  console.log("💾 User cached in Redis");

  return minimalUser;
}

module.exports = { verifyTelegramWithCache };