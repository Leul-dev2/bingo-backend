// Shared game state
const gameSessions = {}; // Stores the current game sessions with player IDs
const startedPlayers = {}; // Stores players who have started the game (by gameId)
const gameCards = {}; // Stores the cards selected for each game (by gameId)

module.exports = {
  gameSessions,
  startedPlayers,
  gameCards,
};
