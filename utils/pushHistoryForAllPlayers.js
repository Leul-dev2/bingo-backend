const PlayerSession = require("../models/PlayerSession");
const Ledger        = require("../models/Ledger");

async function pushHistoryForAllPlayers(strGameSessionId, strGameId, redis) {
    console.log(`🔍🚀 Fetching players for session ${strGameSessionId}...`);

    // 1. Fetch all player sessions
    const sessions = await PlayerSession.find({ GameSessionId: strGameSessionId }).lean();

    if (!sessions.length) {
        console.log("⚠️ No players found for session — skipping history");
        return;
    }

    // 2. Fetch all ledger entries for this session in one aggregate
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

    // 3. Find winner from ledger
    const winnerLedger = await Ledger.findOne({
        gameSessionId:   strGameSessionId,
        transactionType: "player_winnings"
    }).lean();

    const winnerTelegramId = winnerLedger ? winnerLedger.telegramId : null;

    // 4. Final call count from Redis
    const finalCallLengthStr = await redis.get(`finalCalls:${strGameSessionId}`);
    const finalCallLength    = finalCallLengthStr ? parseInt(finalCallLengthStr, 10) : 0;

    // 5. Build player list for the job — filter out any without telegramId
    const players = sessions
        .map(p => ({
            telegramId: p.telegramId || p.TelegramId,
            cardIds:    p.cardIds || [],
        }))
        .filter(p => {
            if (!p.telegramId) {
                console.error(`❌ Session record missing telegramId — skipping`);
                return false;
            }
            return true;
        });

    if (!players.length) {
        console.log("⚠️ No valid players after filter — skipping history");
        return;
    }

    // 6. Push ONE job for the entire session
    const job = JSON.stringify({
        type:            "PROCESS_GAME_HISTORY",
        strGameSessionId,
        strGameId,
        winnerId:        winnerTelegramId || null,
        finalCallLength: finalCallLength  || 0,
        players,
        ledgerData:      allLedgerData,   // pass already-fetched data — no re-fetch in worker
        firedAt:         new Date(),
    });

    await redis.lPush("game-task-queue", job);
    console.log(`✅ Queued 1 history job for session ${strGameSessionId} covering ${players.length} players`);
}

module.exports = { pushHistoryForAllPlayers };
