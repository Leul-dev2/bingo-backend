const PlayerSession = require("../models/PlayerSession");
const Ledger = require("../models/Ledger");

async function pushHistoryForAllPlayers(strGameSessionId, strGameId, redis) {
    console.log(`🔍🚀 Pushing history for session ${strGameSessionId}...`);

    const sessions = await PlayerSession.find({
        GameSessionId: strGameSessionId
    }).lean();

    if (!sessions.length) {
        console.log("⚠️ No players found.");
        return;
    }

    const jobs = [];

    for (const player of sessions) {

        // Get financial data from Ledger
        const ledger = await Ledger.aggregate([
            { $match: { gameSessionId: strGameSessionId, telegramId: player.telegramId } },
            {
                $group: {
                    _id: "$telegramId",
                    totalStake: {
                        $sum: {
                            $cond: [{ $eq: ["$transactionType", "stake_deduction"] }, "$amount", 0]
                        }
                    },
                    totalWin: {
                        $sum: {
                            $cond: [{ $eq: ["$transactionType", "player_winnings"] }, "$amount", 0]
                        }
                    }
                }
            }
        ]);

        const totalStake = ledger[0]?.totalStake || 0;
        const totalWin = ledger[0]?.totalWin || 0;

        jobs.push({
            type: "PROCESS_GAME_HISTORY",
            strGameSessionId,
            strGameId,
            telegramId: player.telegramId,
            winnerId: totalWin > 0 ? String(player.telegramId) : null,
            prizeAmount: totalWin,
            stakeAmount: Math.abs(totalStake),
            cartelaIds: player.cardIds || [],
            callNumberLength: player.callNumberLength || 0,
            firedAt: new Date()
        });
    }

    await redis.lPush("game-task-queue", jobs.map(j => JSON.stringify(j)));

    console.log(`✅ Queued history for ${jobs.length} players`);
}

module.exports = pushHistoryForAllPlayers;
