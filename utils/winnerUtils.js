const GameCard = require("../models/GameCard");
const { getGameDrawsKey } = require("./redisKeys");

async function getDrawnNumbersSet(redis, GameSessionId) {
  const raw = await redis.lRange(getGameDrawsKey(GameSessionId), 0, -1);
  return new Set(raw.map(Number));
}

async function cacheCardIfNotExists(redis, GameCard, gameId, cartelaId) {
  const cacheKey = `cardCache:${gameId}:${cartelaId}`;
  let cached = await redis.get(cacheKey);
  if (cached) return JSON.parse(cached);

  const cardData = await GameCard.findOne({ gameId, cardId: Number(cartelaId) }).lean();
  if (cardData) await redis.set(cacheKey, JSON.stringify(cardData), "EX", 3600);
  return cardData;
}

async function getWinnerInfo(redis, GameSessionId) {
  const data = await redis.get(`winnerInfo:${GameSessionId}`);
  return data ? JSON.parse(data) : null;
}

module.exports = { getDrawnNumbersSet, cacheCardIfNotExists, getWinnerInfo };