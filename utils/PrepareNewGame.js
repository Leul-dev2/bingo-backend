 const { getGameDrawStateKey, getGameActiveKey, getGameDrawsKey } = require("./redisKeys");
 
 
 // Helper to prepare a new game (shuffle numbers, etc.)
    async function prepareNewGame(gameId, gameSessionId, redis, state) {
        // Generate numbers 1–75
        const numbers = Array.from({ length: 75 }, (_, i) => i + 1);

        // ✅ Proper uniform shuffle (Fisher–Yates)
        for (let i = numbers.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [numbers[i], numbers[j]] = [numbers[j], numbers[i]]; // swap
        }
        await redis.set(getGameDrawStateKey(gameSessionId), JSON.stringify({ numbers, index: 0 }));
        // Any other initial setup (e.g., clearing previous session data)
        await Promise.all([
            redis.del(getGameActiveKey(gameId)),
            redis.del(getGameDrawsKey(gameSessionId)),
        ]);
    }

    module.exports = { prepareNewGame };