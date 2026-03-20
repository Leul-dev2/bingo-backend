const { checkBingoPattern }                          = require("../utils/BingoPatterns");
const { ProcessWinner }                              = require("../utils/ProcessWinner");
const { getDrawnNumbersSet, cacheCardIfNotExists, getWinnerInfo } = require("../utils/winnerUtils");

// ─── Atomic rate-limit Lua script ─────────────────────────────────────────────
// Sets TTL atomically on first increment — prevents permanent lockout if process
// crashes between INCR and EXPIRE.
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
    gameId, GameSessionId, cartelaId, selectedNumbers
  }) => {
    // ─── FIX P0: Use server-verified identity — never trust client payload ──
    const telegramId = socket.data.telegramId;
    if (!telegramId) {
        console.warn(`🚫 checkWinner rejected: socket ${socket.id} has no verified telegramId`);
        socket.emit("winnerError", { message: "Not authenticated." });
        return;
    }

    console.time(`checkWinner_${telegramId}`);
    const strGameSessionId = String(GameSessionId);

    try {
      // 1. Winner already declared → redirect late-comers to winner page
      const existingWinner = await getWinnerInfo(redis, strGameSessionId);
      if (existingWinner) {
        return socket.emit("winnerConfirmed", existingWinner);
      }

      // 2. Rate limit — atomic incr+expire via Lua (max 3 claims per 5 min)
      const rateKey = `claimRate:${strGameSessionId}:${telegramId}`;
      const claims  = await redis.eval(RATE_LIMIT_LUA, {
        keys:      [rateKey],
        arguments: ["3", "300"],
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
      const winningNumbers = flatCard.filter((n, i) => pattern[i] && n !== 0); // 0 = FREE space
      const validRecent = lastTwo.some(num => winningNumbers.includes(num));
      
         if (!validRecent) {
      // Provides debugging info back to the client/logs on failure
      return socket.emit("bingoClaimFailed", {
        message: "Winning pattern not completed by recent numbers.",
        telegramId, gameId, cardId: cartelaId, card: cardData.card, lastTwoNumbers: lastTwo, selectedNumbers
      });
    }

      // 5. Atomic winner lock — only one player reaches ProcessWinner
      // ─── FIX P0: TTL increased from 5s to 30s ────────────────────────────
      // Original 5s TTL meant that if ProcessWinner (MongoDB write + prize
      // distribution + event emission) took longer than 5 seconds under DB
      // load, the lock would expire and a second player could claim the same
      // prize. 30s safely covers the entire ProcessWinner execution window.
      const lockKey      = `winnerLock:${strGameSessionId}`;
      const lockAcquired = await redis.set(lockKey, telegramId, { NX: true, EX: 30 });
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
