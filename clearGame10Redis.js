const { createClient } = require("redis");

const redis = createClient({
  url: 'rediss://default:AUQLAAIjcDFiMzAzYjA3MGExZWU0ZmU2OTkxZGU0NDY2OThhNTVkNHAxMA@cool-monarch-17419.upstash.io:6379',
});

redis.on('error', (err) => console.error('Redis Client Error', err));

(async () => {
  try {
    await redis.connect();

    const gameId = "10";

    const keys = await redis.keys(`*${gameId}*`);
    if (keys.length > 0) {
      await redis.del(keys);
      console.log("✅ Deleted keys:", keys);
    } else {
      console.log("ℹ️ No game keys found.");
    }

    const userKeys = await redis.hKeys("userSelections");
    for (const key of userKeys) {
      const value = await redis.hGet("userSelections", key);
      if (value && value.includes(`"gameId":"${gameId}"`)) {
        await redis.hDel("userSelections", key);
        console.log(`🧹 Removed userSelections[${key}]`);
      }
    }

    console.log("✅ Cleanup complete for game 10.");
  } catch (err) {
    console.error("❌ Error:", err);
  } finally {
    await redis.disconnect();
  }
})();
