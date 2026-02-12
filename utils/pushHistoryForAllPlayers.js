// utils/pushHistoryForAllPlayers.js
const PlayerSession = require("../models/PlayerSession");
const Ledger = require("../models/Ledger");

async function pushHistoryForAllPlayers(strGameSessionId, strGameId, redis) {
    const sessions = await PlayerSession.find({ GameSessionId: strGameSessionId }).lean();
    if (!sessions.length) return;

    for (const session of sessions) {
        // Calculate total stake for this player
        const stakeAgg = await Ledger.aggregate([
            {
                $match: {
                    gameSessionId: strGameSessionId,
                    telegramId: session.telegramId,
                    transactionType: "stake_deduction"
                }
            },
            {
                $group: {
                    _id: "$telegramId",
                    total: { $sum: "$amount" }
                }
            }
        ]);

        const totalStake = stakeAgg[0]?.total || 0;

        // Push one history job per player
        const historyJob = {
            type: 'PROCESS_GAME_HISTORY',
            strGameSessionId,
            strGameId,
            winnerId: session.isWinner ? String(session.telegramId) : null, // mark winner if you track it
            prizeAmount: session.isWinner ? session.winAmount || 0 : 0,
            stakeAmount: totalStake,
            callNumberLength: session.callNumberLength || 0,
            firedAt: new Date()
        };

        await redis.lPush('game-task-queue', JSON.stringify(historyJob));
    }

    console.log(`🚀 Queued history for ${sessions.length} players in session ${strGameSessionId}`);
}

module.exports = pushHistoryForAllPlayers;
