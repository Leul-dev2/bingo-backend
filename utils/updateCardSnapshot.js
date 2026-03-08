const updateCardSnapshot = async (gameId, redis) => {
    const takenCardsKey = `takenCards:${gameId}`;
    const gameCardsKey = `gameCards:${gameId}`;

    const takenCardIds = await redis.sMembers(takenCardsKey);
    if (takenCardIds.length === 0) {
        await redis.del(`cardStateSnapshot:${gameId}`);
        return;
    }

    const owners = await redis.hmGet(gameCardsKey, takenCardIds);
    const snapshot = {};

    takenCardIds.forEach((cardId, i) => {
        snapshot[cardId] = {
            cardId: Number(cardId),
            takenBy: owners[i],
            isTaken: true
        };
    });

    await redis.set(`cardStateSnapshot:${gameId}`, JSON.stringify(snapshot));
};


module.exports = { updateCardSnapshot };