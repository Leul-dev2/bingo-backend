const { checkBingoPattern } = require("../utils/BingoPatterns");
const { ProcessWinner } = require("../utils/ProcessWinner");
const { getDrawnNumbersSet, cacheCardIfNotExists, getWinnerInfo } = require("../utils/winnerUtils");

module.exports = function CheckWinnerHandler(socket, io, redis, state) {
  socket.on("checkWinner", async ({ telegramId, gameId, GameSessionId, cartelaId, selectedNumbers }) => {
    console.time(`checkWinner_${telegramId}`);
    const strGameSessionId = String(GameSessionId);

    try {
      // 1. If winner already declared → give them the winner page too!
      const existingWinner = await getWinnerInfo(redis, strGameSessionId);
      if (existingWinner) {
        return socket.emit("winnerConfirmed", existingWinner); // ← LOSERS ALSO SEE WINNER
      }

      // 2. Rate limit (anti-spam)
      const rateKey = `claimRate:${strGameSessionId}:${telegramId}`;
      const claims = await redis.incr(rateKey);
      if (claims === 1) await redis.expire(rateKey, 300);
      if (claims > 3) return socket.emit("winnerError", { message: "Too many claims. Please wait." });

      // 3. Fast Redis + cache path
      const drawnNumbers = await getDrawnNumbersSet(redis, strGameSessionId);
      if (drawnNumbers.size === 0) return socket.emit("winnerError", { message: "No numbers drawn yet." });

      const cardData = await cacheCardIfNotExists(redis, require("../models/GameCard"), gameId, cartelaId);
      if (!cardData) return socket.emit("winnerError", { message: "Card not found." });

      // 4. Validation
      const selectedSet = new Set((selectedNumbers || []).map(Number));
      const pattern = checkBingoPattern(cardData.card, drawnNumbers, selectedSet);
      if (!pattern.some(Boolean)) return socket.emit("winnerError", { message: "No winning pattern." });

      const lastTwo = Array.from(drawnNumbers).slice(-2);
      const flatCard = cardData.card.flat();
      const validRecent = lastTwo.some(num => flatCard.some((n, i) => pattern[i] && n === num));
      if (!validRecent) {
        return socket.emit("bingoClaimFailed", { /* same as before */ });
      }

      // 5. Lock + declare winner
      const lockKey = `winnerLock:${strGameSessionId}`;
      const lockAcquired = await redis.set(lockKey, telegramId, { NX: true, EX: 5 });
      if (!lockAcquired) return socket.emit("winnerError", { message: "Someone else won!" });

      await redis.set(`winnerDeclared:${strGameSessionId}`, "1", "EX", 300);

      // 6. Process (only one player reaches here)
      await ProcessWinner({
        telegramId, gameId, GameSessionId, cartelaId: Number(cartelaId),
        io, selectedSet, state, redis, cardData,
        drawnNumbersRaw: Array.from(drawnNumbers), winnerLockKey: lockKey
      });

    } catch (error) {
      console.error("checkWinner error:", error);
      socket.emit("winnerError", { message: "Internal error." });
    } finally {
      console.timeEnd(`checkWinner_${telegramId}`);
    }
  });
};