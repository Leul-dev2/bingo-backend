const mongoose = require("mongoose");
const GameControl = require("../models/GameControl");
const User = require("../models/user");
const GameCard = require("../models/GameCard");
const Ledger = require("../models/Ledger");
const GlobalGameStats = require("../models/GlobalGameStats");
const PlayerSession = require("../models/PlayerSession");
const { syncGameIsActive } = require("./syncGameIsActive");
const { fullGameCleanup } = require("./fullGameCleanup");
const { startDrawing } = require("./startDrawing");

const HOUSE_CUT_PERCENTAGE = 0.20;
const MIN_PLAYERS_TO_START = 2;

async function processDeductionsAndStartGame(strGameId, strGameSessionId, io, redis, state) {
    const session = await mongoose.startSession();
    let transactionSuccess = false;

    try {
        const gameControlMeta = await GameControl.findOne({ GameSessionId: strGameSessionId }).select('stakeAmount -_id');
        const stakeAmount = gameControlMeta?.stakeAmount || 0;

        // add 1 sec delay to ensure all playerSessions are updated to 'connected' after reconnections
        await new Promise(resolve => setTimeout(resolve, 1000));

        const connectedPlayerSessions = await PlayerSession.find({ 
            GameSessionId: strGameSessionId, 
            status: 'connected' 
        }).select('telegramId cardIds').lean();

        if (connectedPlayerSessions.length < MIN_PLAYERS_TO_START) {
            console.log("🛑 Not enough connected players.");
            io.to(strGameId).emit("gameNotStarted", { message: "Not enough players to start." });
            await fullGameCleanup(strGameId, redis, state);
            await session.endSession();
            return;
        }

        // --- Optimization: Fetch all Users in ONE query ---
        const allTelegramIds = connectedPlayerSessions.map(p => Number(p.telegramId));
        const users = await User.find({ telegramId: { $in: allTelegramIds } }).session(session);

        let successfullyDeductedPlayers = [];
        let finalPlayerObjects = [];
        let totalPot = 0;
        let finalTotalCards = 0;
        let prizeAmount = 0;
        let houseProfit = 0;
        let isHouseCutFree = false;

        // Containers for Bulk Operations
        const userBulkOps = [];
        const ledgerBulkOps = [];

        await session.withTransaction(async () => {
            // A. PREPARE CALCULATIONS & BULK OPERATIONS
            for (const playerSession of connectedPlayerSessions) {
                const playerTelegramId = Number(playerSession.telegramId);
                const numCards = (playerSession.cardIds || []).length;
                
                // 1. Check Cards First
                if (numCards === 0) {
                    console.log(`⚠️ Skipping ${playerTelegramId}: Zero cards found in PlayerSession.`);
                    continue; 
                }

                // 2. FIND the user from the pre-fetched array FIRST
                const user = users.find(u => u.telegramId === playerTelegramId);

                // 3. Safety Check: If user doesn't exist, skip
                if (!user) {
                    console.log(`⚠️ Skipping ${playerTelegramId}: User document not found in DB.`);
                    continue;
                }

                const currentBonus = user.bonus_balance || 0;
                const currentMain = user.balance || 0;
                const totalAvailable = currentBonus + currentMain;
                const stakeToDeduct = stakeAmount * numCards;

                if (user.reservedForGameId !== strGameId) {
                    console.log(`⚠️ Skipping ${playerTelegramId}: Reservation mismatch.`);
                }
                if (totalAvailable < stakeToDeduct) {
                    console.log(`⚠️ Skipping ${playerTelegramId}: Low balance.`);
                }
                
                // 6. Final Validation & Bulk Op Preparation
                if (user.reservedForGameId === strGameId && totalAvailable >= stakeToDeduct) {
                    let remainingCost = stakeToDeduct;
                    let deductedFromBonus = 0;
                    let deductedFromMain = 0;

                    if (currentBonus > 0) {
                        deductedFromBonus = Math.min(currentBonus, remainingCost);
                        remainingCost -= deductedFromBonus;
                    }
                    if (remainingCost > 0) {
                        deductedFromMain = remainingCost;
                    }

                    userBulkOps.push({
                        updateOne: {
                            filter: { telegramId: playerTelegramId },
                            update: { 
                                $inc: { balance: -deductedFromMain, bonus_balance: -deductedFromBonus },
                                $unset: { reservedForGameId: "" }
                            }
                        }
                    });

                    const transType = (deductedFromMain > 0) ? 'stake_deduction' : 'bonus_stake_deduction';
                    ledgerBulkOps.push({
                        insertOne: {
                            document: {
                                gameSessionId: strGameSessionId,
                                amount: -stakeToDeduct,
                                transactionType: transType,
                                telegramId: String(playerTelegramId),
                                description: `Stake for ${numCards} cards (Bonus: ${deductedFromBonus}, Main: ${deductedFromMain})`
                            }
                        }
                    });

                    successfullyDeductedPlayers.push(playerTelegramId);
                    finalPlayerObjects.push({ telegramId: playerTelegramId, status: 'connected' });
                    totalPot += stakeToDeduct;
                    finalTotalCards += numCards;
                } else {
                    userBulkOps.push({
                        updateOne: {
                            filter: { telegramId: playerTelegramId },
                            update: { $unset: { reservedForGameId: "" } }
                        }
                    });
                }
            }

            // B. EXECUTE ALL DATABASE WRITES IN 2 CALLS
            if (successfullyDeductedPlayers.length < MIN_PLAYERS_TO_START) {
                throw new Error("MIN_PLAYERS_NOT_MET_AFTER_DEDUCTION");
            }

            if (userBulkOps.length > 0) {
                await User.bulkWrite(userBulkOps, { session });
            }
            if (ledgerBulkOps.length > 0) {
                await Ledger.bulkWrite(ledgerBulkOps, { session });
            }

            // C. HOUSE CUT & STATS
            const today = new Date();
            today.setHours(0, 0, 0, 0);
            const stats = await GlobalGameStats.findOneAndUpdate(
                { date: today },
                { $inc: { gamesPlayed: 1 } },
                { new: true, upsert: true, session }
            ).select('gamesPlayed');

            if (stats.gamesPlayed % 7 === 0) {
                prizeAmount = totalPot;
                isHouseCutFree = true;
            } else {
                houseProfit = totalPot * HOUSE_CUT_PERCENTAGE;
                prizeAmount = totalPot - houseProfit;
            }

            // D. ACTIVATE GAME & UPDATE CARDS (takenBy)
            await GameControl.findOneAndUpdate(
                { GameSessionId: strGameSessionId, isActive: false },
                { $set: { isActive: true, totalCards: finalTotalCards, prizeAmount, houseProfit, isHouseCutFree, players: finalPlayerObjects } },
                { session }
            );

            await GameCard.updateMany(
                { gameId: strGameId, isTaken: true, takenBy: { $in: successfullyDeductedPlayers } }, 
                { $set: { GameSessionId: strGameSessionId } },
                { session }
            );

            // 2. RELEASE ALL CARDS IN DATABASE (Mongo only - stays inside transaction)
            await GameCard.updateMany(
                { gameId: strGameId },
                { 
                    $set: { isTaken: false },
                    $unset: { takenBy: "", GameSessionId: "" }
                },
                { session }
            );
            console.log(`✅ DB: Released ALL cards for game ${strGameId} → ready for next lobby`);
        });

        transactionSuccess = true;

        // ── SUCCESS PATH ONLY: Redis cleanup (outside transaction so it doesn't rollback) ──
        await redis.del(`gameCards:${strGameId}`);
        await redis.del(`takenCards:${strGameId}`);

        const userHeldPattern = `userHeldCards:${strGameId}:*`;
        const allUserHeldKeys = await redis.keys(userHeldPattern);
        if (allUserHeldKeys.length > 0) {
            await redis.del(...allUserHeldKeys);
            console.log(`🧹 Redis: Deleted ${allUserHeldKeys.length} userHeldCards keys`);
        }

        await redis.del(`userSelections`);
        await redis.del(`userSelectionsByTelegramId`);

        io.to(strGameId).emit("gameCardResetOngameStart");
        console.log(`🚀 Full Redis reset complete → Lobby is now 100% clean for next game`);

        // 3. POST-COMMIT TASKS
        await syncGameIsActive(strGameId, true, redis);
        
        // Parallel Redis Balance Sync
        await Promise.all(successfullyDeductedPlayers.map(async (id) => {
            const u = await User.findOne({ telegramId: id }).select('balance bonus_balance').lean();
            if (u) {
                await redis.set(`userBalance:${id}`, u.balance.toString(), "EX", 60);
                await redis.set(`userBonusBalance:${id}`, u.bonus_balance.toString(), "EX", 60);
            }
        }));

        delete state.activeDrawLocks[strGameId];
        io.to(strGameId).emit("gameDetails", {
            winAmount: prizeAmount,
            playersCount: successfullyDeductedPlayers.length,
            cardCount: finalTotalCards,
            stakeAmount,
            totalDrawingLength: 75,
            isHouseCutFree
        });
        io.to(strGameId).emit("gameStart", { gameId: strGameId });
        await startDrawing(strGameId, strGameSessionId, io, state, redis);

    } catch (error) {
        console.error("❌ Transaction Aborted:", error.message);
        io.to(strGameId).emit("gameNotStarted", { message: "Game aborted. Funds safe." });
        await fullGameCleanup(strGameId, redis, state);
    } finally {
        await redis.del(`gameStarting:${strGameId}`);
        await session.endSession();
    }
}

module.exports = { processDeductionsAndStartGame };