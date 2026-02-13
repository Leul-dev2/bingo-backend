const mongoose = require('mongoose');
const GameControl = require("../models/GameControl");
const GameCard = require("../models/GameCard");
const User = require("../models/user");
const GameHistory = require("../models/GameHistory")
const Ledger = require("../models/Ledger");
//const redis = require("./redisClient");
const postCommitCleanup = require("./postCommitCleanup");
const { v4: uuidv4 } = require("uuid");

const DEFAULT_CREATED_BY = 'System';
const DEFAULT_GAME_TOTAL_CARDS = 1;
const HOUSE_ID = "HOUSE";

// REFINED SIGNATURE: Removed unused 'gameControl', Added required 'state'
async function processWinnerAtomicCommit(winnerData, winnerUser, io, redis, state) {
    const { telegramId, strGameId, strGameSessionId, prizeAmount, houseProfit, stakeAmount, cartelaId, callNumberLength } = winnerData;
    const strTelegramId = String(telegramId);
    // Start the transaction session
    const session = await mongoose.startSession();
    
    try {
        await session.withTransaction(async () => {
            
            // 1. FINANCIAL COMMIT: Payout and Ledger (ACTIVE -> ENDED)
            // A. Update Winner's Balance
            await User.updateOne(
                { telegramId: strTelegramId }, 
                { $inc: { balance: prizeAmount } }, 
                { session } // CRITICAL: Must use session
            );
            
            // B. Create Winner Ledger Entry
            await Ledger.create([{
                gameSessionId: strGameSessionId, amount: prizeAmount, transactionType: 'player_winnings', telegramId: strTelegramId
            }], { session });

            // C. Create House Ledger Entry
            await Ledger.create([{
                gameSessionId: strGameSessionId, amount: houseProfit, transactionType: 'house_profit',  telegramId: HOUSE_ID
            }], { session });
            
            // D. Create Winner GameHistory (Must be in transaction to ensure integrity)
            // await GameHistory.create([{
            //     sessionId: strGameSessionId, gameId: strGameId, username: winnerUser.username || "Unknown", telegramId, 
            //     eventType: "win", winAmount: prizeAmount, stake: stakeAmount, cartelaId, callNumberLength
            // }], { session });


            // 2. END OLD GAME (The Active document becomes the Historical document)
            const oldGameControl = await GameControl.findOneAndUpdate(
                { GameSessionId: strGameSessionId, isActive: true, endedAt: null },
                { $set: { isActive: false, endedAt: new Date() } }, // ENDED STATE
                { session }
            );

            if (!oldGameControl) {
                // This ensures we don't proceed if the game was double-claimed or already ended.
                throw new Error("GAME_SESSION_NOT_ACTIVE_FOR_COMMIT");
            }

            // 3. ATOMICALLY CREATE NEXT LOBBY (The core transition)
            try {
                // The fixed Unique Partial Index ensures this is safe
                await GameControl.create([{
                    GameSessionId: uuidv4(),
                    gameId: strGameId,
                    isActive: false, // NEW LOBBY STATE
                    createdBy: DEFAULT_CREATED_BY,
                    stakeAmount: stakeAmount, // Carry over stake amount
                    totalCards: DEFAULT_GAME_TOTAL_CARDS,
                    prizeAmount: 0,
                    houseProfit: 0,
                    createdAt: new Date(),
                    endedAt: null,
                }], { session });
                
            } catch (e) {
                // E11000 is okay, another process beat us to lobby creation.
                if (e.code !== 11000) throw e; 
            }
            
            // 4. CLEANUP: Reset GameCards for the finished session
            await GameCard.updateMany(
                { gameId: strGameId, GameSessionId: strGameSessionId },
                { $set: { isTaken: false, takenBy: null, GameSessionId: null } },
                { session }
            );

        }); // END TRANSACTION COMMIT

        // --- Post-Commit: Redis updates and Broadcast (Fast I/O) ---
        
        // A. Update winner's balance in Redis cache
        await redis.incrByFloat(`userBalance:${strTelegramId}`, prizeAmount); 
        
        // B. Perform all Redis/State cleanup
        await postCommitCleanup(strGameId, strGameSessionId, io, redis, state);
        
        // C. Clean up in-memory state (Using the now-passed 'state' object)
        if (state && state.drawIntervals && state.drawIntervals[strGameId]) {
            clearInterval(state.drawIntervals[strGameId]);
            delete state.drawIntervals[strGameId];
        }
        
    } catch (error) {
        // Abort on any failure (financial, state update, or critical error)
        //await session.abortTransaction();
        if (error.message.includes("GAME_SESSION_NOT_ACTIVE_FOR_COMMIT")) {
            console.warn(`⚠️ Atomic commit failed: Game session ${strGameSessionId} was already ended.`);
        } else {
            console.error(`🔥 CRITICAL WINNER COMMIT FAILURE for ${strGameId}:`, error);
        }
        
    } finally {
        await session.endSession();
    }
}


module.exports = processWinnerAtomicCommit;