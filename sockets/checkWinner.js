const { checkBingoPattern }                          = require("../utils/BingoPatterns");
const { ProcessWinner }                              = require("../utils/ProcessWinner");
const { getDrawnNumbersSet, cacheCardIfNotExists, getWinnerInfo } = require("../utils/winnerUtils");

// ─── FIX P1: Atomic rate-limit Lua script ─────────────────────────────────────
// Original code used redis.incr() + redis.expire() as two separate calls.
// If the process crashed between them, the key would exist forever with no TTL,
// permanently locking the player out of claiming a win.
// This Lua script sets the TTL atomically on the very first increment.
const RATE_LIMIT_LUA = `
local key     = KEYS[1]
local limit   = tonumber(ARGV[1])
local ttl     = tonumber(ARGV[2])

local current = redis.call("INCR", key)
if current == 1 then
    redis.call("EXPIRE", key, ttl)
end
return current
`;

module.exports = function CheckWinnerHandler(socket, io, redis, state) {
  socket.on("checkWinner", async ({
    telegramId, gameId, GameSessionId, cartelaId, selectedNumbers
  }) => {
    console.time(`checkWinner_${telegramId}`);
    const strGameSessionId = String(GameSessionId);

    try {
      // 1. Winner already declared → redirect late-comers to winner page
      const existingWinner = await getWinnerInfo(redis, strGameSessionId);
      if (existingWinner) {
        return socket.emit("winnerConfirmed", existingWinner);
      }

      // 2. Rate limit — FIX P1: atomic incr+expire via Lua (max 3 claims per 5 min)
      const rateKey = `claimRate:${strGameSessionId}:${telegramId}`;
      const claims  = await redis.eval(RATE_LIMIT_LUA, {
        keys:      [rateKey],
        arguments: ["3", "300"],   // limit=3, ttl=300s
      });
      if (claims > 3) {
        return socket.emit("winnerError", { message: "Too many claims. Please wait." });
      }

      // 3. Fast Redis + cache path
      const drawnNumbers = await getDrawnNumbersSet(redis, strGameSessionId);
      if (drawnNumbers.size === 0) {
        return socket.emit("winnerError", { message: "No numbers drawn yet." });
      }

      const cardData = await cacheCardIfNotExists(
        redis,
        require("../models/GameCard"),
        gameId,
        cartelaId
      );
      if (!cardData) {
        return socket.emit("winnerError", { message: "Card not found." });
      }

      // 4. Pattern validation
      const selectedSet = new Set((selectedNumbers || []).map(Number));
      const pattern     = checkBingoPattern(cardData.card, drawnNumbers, selectedSet);
      if (!pattern.some(Boolean)) {
        return socket.emit("winnerError", { message: "No winning pattern." });
      }

      const lastTwo  = Array.from(drawnNumbers).slice(-2);
      const flatCard = cardData.card.flat();
      const validRecent = lastTwo.some(
        (num) => flatCard.some((n, i) => pattern[i] && n === num)
      );
      if (!validRecent) {
        return socket.emit("bingoClaimFailed", {
          message: "Claim rejected: last drawn number not on your winning line.",
        });
      }

      // 5. Atomic winner lock — only one player reaches ProcessWinner
      const lockKey     = `winnerLock:${strGameSessionId}`;
      const lockAcquired = await redis.set(lockKey, telegramId, { NX: true, EX: 5 });
      if (!lockAcquired) {
        return socket.emit("winnerError", { message: "Someone else won!" });
      }

      await redis.set(`winnerDeclared:${strGameSessionId}`, "1", "EX", 300);

      // 6. Process winner (only one player ever reaches here per session)
      await ProcessWinner({
        telegramId,
        gameId,
        GameSessionId,
        cartelaId:       Number(cartelaId),
        io,
        selectedSet,
        state,
        redis,
        cardData,
        drawnNumbersRaw: Array.from(drawnNumbers),
        winnerLockKey:   lockKey,
      });

    } catch (error) {
      console.error("checkWinner error:", error);
      socket.emit("winnerError", { message: "Internal error." });
    } finally {
      console.timeEnd(`checkWinner_${telegramId}`);
    }
  });
};
