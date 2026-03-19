const { processWinnerAtomicCommit } = require("./processWinnerAtomicCommit");
const { pushHistoryForAllPlayers }  = require("./pushHistoryForAllPlayers");
const { resetRound }                = require("./resetRound");

async function ProcessWinner({ telegramId, gameId, GameSessionId, cartelaId, io, selectedSet, state, redis, cardData, drawnNumbersRaw, winnerLockKey }) {
  const strGameId        = String(gameId);
  const strGameSessionId = String(GameSessionId);

  const [gameControl, winnerUser] = await Promise.all([
    require("../models/GameControl").findOne({ GameSessionId: strGameSessionId })
      .select('prizeAmount houseProfit stakeAmount totalCards').lean(),
    require("../models/user").findOne({ telegramId })
  ]);

  if (!gameControl || !winnerUser) {
    await redis.del(winnerLockKey);
    return;
  }

  const { prizeAmount, houseProfit, stakeAmount, totalCards: playerCount } = gameControl;
  const board         = cardData.card;
  const winnerPattern = require("../utils/BingoPatterns").checkBingoPattern(board, new Set(drawnNumbersRaw), selectedSet);
  const callNumberLength = drawnNumbersRaw.length;

  const winnerData = {
    winnerName:    winnerUser.username || "Unknown",
    prizeAmount,
    playerCount,
    boardNumber:   cartelaId,
    board,
    winnerPattern,
    telegramId,
    gameId:        strGameId,
    GameSessionId: strGameSessionId,
  };

  let commitSuccess = false;
  try {
    await processWinnerAtomicCommit(
      { telegramId: Number(telegramId), strGameId, strGameSessionId, prizeAmount, houseProfit, stakeAmount, cartelaId, callNumberLength },
      winnerUser, io, redis, state);
   // await pushHistoryForAllPlayers(strGameSessionId, strGameId, redis);
    commitSuccess = true;
  } catch (e) {
    console.error("Commit failed:", e);
  }

  await redis.del(winnerLockKey);

  if (commitSuccess) {
    // 1. Save winner info so late clickers also see it
    await redis.set(`winnerInfo:${strGameSessionId}`, JSON.stringify(winnerData), "EX", 300);

    // 2. Broadcast to everyone
    io.to(strGameId).emit("winnerConfirmed", winnerData);
    io.to(strGameId).emit("gameEnded", { message: "Winner found!" });

    // 3. Stop drawing
    await redis.del(`lock:drawing:${strGameId}`);
    if (state.drawIntervals?.[strGameId]) {
      clearInterval(state.drawIntervals[strGameId]);
      delete state.drawIntervals[strGameId];
    }

    // 4. Reset after delay so clients can see the winner screen before lobby resets
    // resetRound: marks DB isActive=false, clears all Redis locks, emits gameReset
      try {
        await resetRound(strGameId, strGameSessionId, null, io, state, redis);
        console.log(`✅ [ProcessWinner] resetRound completed for game ${strGameId}`);
      } catch (err) {
        console.error(`❌ [ProcessWinner] resetRound failed for game ${strGameId}:`, err);
      }
   

  } else {
    await redis.del(`winnerDeclared:${strGameSessionId}`);
  }
}

module.exports = { ProcessWinner };
