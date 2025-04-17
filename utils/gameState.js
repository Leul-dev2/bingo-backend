// utils/gameState.js

const gameSessions = {};     // gameId -> [telegramId]
const userSelections = {};   // socket.id -> { telegramId, gameId, cardId }
const gameCards = {};        // gameId -> { cardId: telegramId }
const startedPlayers = {};   // gameId -> [telegramId]

module.exports = {
  gameSessions,
  userSelections,
  gameCards,
  startedPlayers
};
