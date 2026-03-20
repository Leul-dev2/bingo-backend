const PlayerSession = require("../models/PlayerSession");
const Ledger = require("../models/Ledger");


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
    

    console.log("ALL LEDGER DATA:", allLedgerData);


  const winnerLedger = await Ledger.findOne({
    gameSessionId: strGameSessionId,
    transactionType: "player_winnings"
  }).lean();

 const winnerTelegramId = winnerLedger ? winnerLedger.telegramId : null;

    // Create a map for O(1) lookup: { "12345": { totalStake: 10, totalWin: 50 } }
    const ledgerMap = new Map(allLedgerData.map(item => [String(item._id), item]));

    console.log("Ledger Map Keys:", [...ledgerMap.keys()]);
    // 4. Final call count from Redis (set in ProcessWinner) – same value for all players
    const finalCallLengthStr = await redis.get(`finalCalls:${strGameSessionId}`);
    const finalCallLength = finalCallLengthStr ? parseInt(finalCallLengthStr, 10) : 0;

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
      
      

        console.log(`Player ${tId} - Total Stake: ${totalStake}, Total Win: ${totalWin}, Winner-ID: ${winnerTelegramId}`);
        jobs.push({
            type: "PROCESS_GAME_HISTORY",
            strGameSessionId,
            strGameId,
            telegramId: tId,
            winnerId: winnerTelegramId || null, // Mark the winner
            prizeAmount: totalWin || 0,
            stakeAmount: Math.abs(totalStake),
            cartelaIds: player.cardIds || [],
            callNumberLength:finalCallLength|| 0,
            firedAt: new Date()
        });
    }

    if (jobs.length > 0) {
        await redis.lPush("game-task-queue", jobs.map(j => JSON.stringify(j)));
        console.log(`✅ Queued history for ${jobs.length} players`);
    }
}

module.exports = { pushHistoryForAllPlayers };
