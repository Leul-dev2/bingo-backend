const PlayerSession = require("../models/PlayerSession");
const Ledger = require("../models/Ledger");
const e = require("cors");

async function pushHistoryForAllPlayers(strGameSessionId, strGameId, redis) {
    console.log(`🔍🚀 Fetching players for session ${strGameSessionId}...`);

    // 1. Fetch all player sessions
    const sessions = await PlayerSession.find({ GameSessionId: strGameSessionId }).lean();

    if (!sessions.length) {
        console.log("⚠️ No players found.");
        return;
    }

  

    // 2. Optimization: Fetch ALL ledger entries for this session in ONE go
    const allLedgerData = await Ledger.aggregate([
        { $match: { gameSessionId: strGameSessionId } },
        {
            $group: {
                _id: "$telegramId",
                totalStake: {
                    $sum: { $cond: [{ $eq: ["$transactionType", "stake_deduction"] }, "$amount", 0] }
                },
                totalWin: {
                    $sum: { $cond: [{ $eq: ["$transactionType", "player_winnings"] }, "$amount", 0] }
                }
            }
        }
    ]);

    const winnerEntry = allLedgerData.find(item => item.totalWin > 0);
    const winnerTelegramId = winnerEntry ? String(winnerEntry._id) : null;

    // Create a map for O(1) lookup: { "12345": { totalStake: 10, totalWin: 50 } }
    const ledgerMap = new Map(allLedgerData.map(item => [String(item._id), item]));

    const jobs = [];

    for (const player of sessions) {
        // SAFETY: Check both lowercase and uppercase just in case
        const tId = player.telegramId || player.TelegramId;

        if (!tId) {
            console.error(`❌ Found a session record without a telegramId! ID: ${player._id}`);
            continue; 
        }
        console.log(`📞📞📞📞Processing player ${tId} with session ID ${player._id}`);
        const playerLedger = ledgerMap.get(String(tId)) || { totalStake: 0, totalWin: 0 };
        const totalStake = playerLedger.totalStake || 0;
        const totalWin = playerLedger.totalWin || 0;
        let determinedWinnerId = null;
      

        console.log(`Player ${tId} - Total Stake: ${totalStake}, Total Win: ${totalWin}, Winner ID: ${determinedWinnerId}`);
        jobs.push({
            type: "PROCESS_GAME_HISTORY",
            strGameSessionId,
            strGameId,
            telegramId: tId,
            winnerId: winnerTelegramId || null, // Mark the winner
            prizeAmount: totalWin || 0,
            stakeAmount: Math.abs(totalStake),
            cartelaIds: player.cardIds || [],
            callNumberLength: player.callNumberLength || 0,
            firedAt: new Date()
        });
    }

    if (jobs.length > 0) {
        await redis.lPush("game-task-queue", jobs.map(j => JSON.stringify(j)));
        console.log(`✅ Queued history for ${jobs.length} players`);
    }
}

module.exports = pushHistoryForAllPlayers;
