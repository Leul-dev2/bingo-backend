const redis = require('./redisClient');

async function deleteCardsByTelegramId(gameId, telegramId) {
  const gameCardsKey = `gameCards:${gameId}`;

  // Get all cardId -> telegramId mappings
  const allCards = await redis.hGetAll(gameCardsKey);

  const cardIdsToDelete = [];
  for (const [cardId, ownerTelegramId] of Object.entries(allCards)) {
    if (ownerTelegramId === telegramId) {
      cardIdsToDelete.push(cardId);
    }
  }

  if (cardIdsToDelete.length > 0) {
    await redis.hDel(gameCardsKey, ...cardIdsToDelete);
    console.log(`🗑️ Deleted ${cardIdsToDelete.length} card(s) owned by telegramId ${telegramId} from Redis in game ${gameId}`);
  } else {
    console.log(`No cards owned by telegramId ${telegramId} found in Redis game ${gameId}`);
  }
}


module.exports = deleteCardsByTelegramId;