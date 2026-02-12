// utils/pushHistoryForAllPlayers.js
const Ledger = require("../models/Ledger");

async function pushHistoryForAllPlayers(strGameSessionId, strGameId, redis) {
    console.log(`🔍🚀 Pushing history for all players in session ${strGameSessionId}...`);

    // Get all distinct player IDs from the Ledger for this session
    const playerIds = await Ledger.distinct("telegramId", { gameSessionId: strGameSessionId });
    
    if (!playerIds.length) {
        console.log(`⚠️ No ledger entries found for session ${strGameSessionId}. Skipping history push.`);
        return;
    }

    for (const telegramId of playerIds) {
        // Aggregate total stake for this player from Ledger
        const stakeAgg = await Ledger.aggregate([
            { $match: { gameSessionId: strGameSessionId, telegramId, transactionType: "stake_deduction" } },
            { $group: { _id: "$telegramId", total: { $sum: "$amount" } } }
        ]);

        const totalStake = stakeAgg[0]?.total || 0;

        // Optionally, you can also sum winnings from Ledger if needed
        const winAgg = await Ledger.aggregate([
            { $match: { gameSessionId: strGameSessionId, telegramId, transactionType: "player_winnings" } },
            { $group: { _id: "$telegramId", totalWin: { $sum: "$amount" } } }
        ]);

        const totalWin = winAgg[0]?.totalWin || 0;

        const historyJob = {
            type: 'PROCESS_GAME_HISTORY',
            strGameSessionId,
            strGameId,
            winnerId: totalWin > 0 ? String(telegramId) : null, // mark winner if they have winnings
            prizeAmount: totalWin,
            stakeAmount: totalStake,
            callNumberLength: 0, // or derive from your game logic if stored in Ledger
            firedAt: new Date()
        };

        await redis.lPush('game-task-queue', JSON.stringify(historyJob));
    }

    console.log(`🚀 Queued history for ${playerIds.length} players in session ${strGameSessionId}`);
}

module.exports = pushHistoryForAllPlayers;
