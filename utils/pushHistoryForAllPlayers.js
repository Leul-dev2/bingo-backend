// utils/pushHistoryForAllPlayers.js
const Ledger = require("../models/Ledger");


async function pushHistoryForAllPlayers(strGameSessionId, strGameId, redis) {
    console.log(`🔍🚀 Pushing history for all players in session ${strGameSessionId}...`);

    // Get all players who have any ledger entry for this game
    const playerIds = await Ledger.distinct("telegramId", { gameSessionId: strGameSessionId });
    
    if (!playerIds.length) {
        console.log(`⚠️ No ledger entries found for session ${strGameSessionId}. Skipping.`);
        return;
    }

    const historyJobs = [];

    for (const telegramId of playerIds) {
        // Sum stakes for this player
        const stakeAgg = await Ledger.aggregate([
            { $match: { gameSessionId: strGameSessionId, telegramId, transactionType: "stake_deduction" } },
            { $group: { _id: "$telegramId", totalStake: { $sum: "$amount" } } }
        ]);
        const totalStake = stakeAgg[0]?.totalStake || 0;

        // Sum winnings (winner only)
        const winAgg = await Ledger.aggregate([
            { $match: { gameSessionId: strGameSessionId, telegramId, transactionType: "player_winnings" } },
            { $group: { _id: "$telegramId", totalWin: { $sum: "$amount" } } }
        ]);
        const totalWin = winAgg[0]?.totalWin || 0;

        const historyJob = {
            type: 'PROCESS_GAME_HISTORY',
            strGameSessionId,
            strGameId,
            winnerId: totalWin > 0 ? String(telegramId) : null, // mark winner
            prizeAmount: totalWin,
            stakeAmount: Math.abs(totalStake), // stake deduction is negative
            callNumberLength: 0, // optional: if you store in ledger, use it
            firedAt: new Date()
        };

        historyJobs.push(historyJob);
    }

    if (historyJobs.length) {
        // Push all jobs at once for atomicity
        await redis.lPush('game-task-queue', historyJobs.map(j => JSON.stringify(j)));
        console.log(`🚀 Queued history for ${historyJobs.length} players in session ${strGameSessionId}`);
    }
}

module.exports = pushHistoryForAllPlayers;
