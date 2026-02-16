const GameControl = require("../models/GameControl");
const User = require("../models/user");
const { checkBingoPattern } = require("./BingoPatterns");
const { processWinnerAtomicCommit } = require("./processWinnerAtomicCommit");
const { pushHistoryForAllPlayers } = require("./pushHistoryForAllPlayers"); 

  
  async function processWinner({ telegramId, gameId, GameSessionId, cartelaId, io, selectedSet, state, redis, cardData, drawnNumbersRaw, winnerLockKey }) {
        const strGameId = String(gameId);
        const strGameSessionId = String(GameSessionId);

        // --- 1️⃣ Initial Data Fetching and Validation (PRE-COMMIT) ---
        // 🟢 CORRECTION 1: Use .select('players...') and .lean() to fetch the definitive list of paid participants.
        const [gameControl, winnerUser] = await Promise.all([
            GameControl.findOne({ GameSessionId: strGameSessionId })
                       .select('players prizeAmount houseProfit stakeAmount totalCards')
                       .lean(),
            User.findOne({ telegramId }),
        ]);

        if (!gameControl || !winnerUser) {
            console.warn(`🚫 Missing GameControl or WinnerUser for session ${strGameSessionId}. Aborting.`);
            await redis.del(winnerLockKey); // Release lock
            return;
        }

        // --- 2️⃣ Calculate Dynamic Values (PRE-COMMIT) ---
        // The GameControl document must contain the 'players' array for accurate loser tracking.
        const { prizeAmount, houseProfit, stakeAmount, totalCards: playerCount } = gameControl;
        const board = cardData.card;
        
        // Assumes checkBingoPattern is a globally available helper function
        const winnerPattern = checkBingoPattern(board, new Set(drawnNumbersRaw.map(Number)), selectedSet); 
        const callNumberLength = drawnNumbersRaw ? drawnNumbersRaw.length : 0; 
        
        // Consolidated data package for the atomic commit and deferred tasks
        const winnerData = { 
            telegramId: Number(telegramId), // Ensure type consistency
            strGameId, 
            strGameSessionId, 
            prizeAmount, 
            houseProfit, 
            stakeAmount, 
            cartelaId: Number(cartelaId),
            callNumberLength,
        };

        // --- 3️⃣ Broadcast winner information (IMMEDIATE RESPONSE) ---
        io.to(strGameId).emit("winnerConfirmed", { 
            winnerName: winnerUser.username || "Unknown", 
            prizeAmount, 
            playerCount, 
            boardNumber: cartelaId, 
            board,
            winnerPattern, 
            telegramId, 
            gameId: strGameId, 
            GameSessionId: strGameSessionId 
        });
        io.to(strGameId).emit("gameEnded", { message: "Winner found, game ended." });

          const winnerId = telegramId;
            // --- 4️⃣ Atomic Financial Commit & State Transition (CRITICAL) ---
            try {
          // Pass the necessary IO and Redis clients for post-commit cleanup (not inside the transaction)
             await processWinnerAtomicCommit(winnerData, winnerUser, io, redis, state); 
             await pushHistoryForAllPlayers(strGameSessionId, strGameId, redis);
            
            // Release the winner lock immediately after the atomic commit succeeds
            await redis.del(winnerLockKey); 

        } catch (error) {
            console.error("🔥 processWinner execution error:", error);
            // Ensure lock is released quickly if the atomic commit failed
            await redis.del(winnerLockKey).catch(err => console.error("Lock release error:", err));
        }
    }


    module.exports = { processWinner };