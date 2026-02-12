async function handleGameOutcome(job) {
    const { strGameSessionId, strGameId } = job;

    // Redis lock for session
    const lockKey = `processing:${strGameSessionId}`;
    const lockAcquired = await redis.set(lockKey, "1", { NX: true, EX: 60 });
    if (!lockAcquired) {
        console.log(`⚠️ Session ${strGameSessionId} is already being processed. Skipping job.`);
        return;
    }

    try {
        console.log(`🚀 Processing session ${strGameSessionId}...`);

        // Get all players from Ledger
        const ledgerPlayers = await Ledger.aggregate([
            { $match: { gameSessionId: strGameSessionId, transactionType: { $in: ["stake_deduction","player_winnings"] } } },
            { $group: { 
                _id: "$telegramId",
                totalStake: { $sum: { $cond: [{ $eq: ["$transactionType","stake_deduction"] }, "$amount", 0] } },
                totalWin: { $sum: { $cond: [{ $eq: ["$transactionType","player_winnings"] }, "$amount", 0] } }
            }}
        ]);

        if (!ledgerPlayers.length) {
            console.log(`⚠️ No ledger entries for session ${strGameSessionId}. Skipping.`);
            return;
        }

        const telegramIds = ledgerPlayers.map(p => Number(p._id));
        const users = await User.find({ telegramId: { $in: telegramIds } }, 'telegramId username').lean();
        const userMap = new Map(users.map(u => [String(u.telegramId), u.username]));

        const historyEntries = ledgerPlayers.map(player => ({
            sessionId: strGameSessionId,
            gameId: strGameId,
            telegramId: player._id,
            username: userMap.get(String(player._id)) || "Player",
            eventType: player.totalWin > 0 ? "win" : "lose",
            winAmount: player.totalWin,
            stake: Math.abs(player.totalStake),
            cartelaIds: [],
            callNumberLength: 0,
            createdAt: new Date()
        }));

        await GameHistory.insertMany(historyEntries);

        console.log(`✅ Session ${strGameSessionId} processed. ${historyEntries.length} records saved.`);

    } finally {
        await redis.del(lockKey);
    }
}
