const GameCard = require("../models/GameCard");
const { checkBingoPattern } = require("../utils/BingoPatterns"); 
const ProcessWinner = require("../utils/ProcessWinner");
 
 
 module.exports = function CheckWinnerHandler(socket, io, redis, state, processWinner) {
    socket.on("checkWinner", async ({ telegramId, gameId, GameSessionId, cartelaId, selectedNumbers }) => {
        console.time(`⏳checkWinner_${telegramId}`);

      try {
        const selectedSet = new Set((selectedNumbers || []).map(Number));
        const numericCardId = Number(cartelaId);
        if (isNaN(numericCardId)) {
          return socket.emit("winnerError", { message: "Invalid card ID." });
        }

        // --- 1️⃣ Fetch drawn numbers from Redis (Non-redundant fetch) ---
        const drawnNumbersRaw = await redis.lRange(`gameDraws:${GameSessionId}`, 0, -1);
        if (!drawnNumbersRaw?.length) return socket.emit("winnerError", { message: "No numbers drawn yet." });
        const drawnNumbersArray = drawnNumbersRaw.map(Number);
        const lastTwoDrawnNumbers = drawnNumbersArray.slice(-2);
        const drawnNumbers = new Set(drawnNumbersArray);

        // --- 2️⃣ Fetch cardData once (Cache data for processor) ---
        const cardData = await GameCard.findOne({ gameId, cardId: numericCardId });
        if (!cardData) return socket.emit("winnerError", { message: "Card not found." });

        // --- 3️⃣ Check bingo pattern in memory ---
        const pattern = checkBingoPattern(cardData.card, drawnNumbers, selectedSet);
        if (!pattern.some(Boolean)) return socket.emit("winnerError", { message: "No winning pattern." });

        // --- 4️⃣ Check recent numbers in pattern (Critical game rule validation) ---
        const flatCard = cardData.card.flat();
        const isRecentNumberInPattern = lastTwoDrawnNumbers.some(num =>
          // Checks if the recent number 'num' is present in the card and corresponds to a winning cell (pattern[i] === true)
          flatCard.some((n, i) => pattern[i] && n === num)
        );
        if (!isRecentNumberInPattern) {
          // Provides debugging info back to the client/logs on failure
          return socket.emit("bingoClaimFailed", {
            message: "Winning pattern not completed by recent numbers.",
            telegramId, gameId, cardId: cartelaId, card: cardData.card, lastTwoNumbers: lastTwoDrawnNumbers, selectedNumbers
          });
        }

        // --- 5️⃣ Acquire winner lock in Redis (Minimize DB calls inside lock) ---
        const winnerLockKey = `winnerLock:${GameSessionId}`;
        // EX: 30 seconds expiry (Increased for safety), NX: Only set if Not eXists
        const lockAcquired = await redis.set(winnerLockKey, telegramId, { NX: true, EX: 30 });
        if (!lockAcquired) return; // Someone else won and acquired the lock first

        // --- 6️⃣ Call optimized winner processor, passing cached data ---
        await processWinner({
          telegramId, gameId, GameSessionId, cartelaId, io, selectedSet, state, redis, cardData, drawnNumbersRaw, winnerLockKey
        });

      } catch (error) {
        console.error("checkWinner error:", error);
        socket.emit("winnerError", { message: "Internal error." });
      } finally {
        console.timeEnd(`⏳checkWinner_${telegramId}`);
      }
    });
}