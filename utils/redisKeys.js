// utils/redisKeys.js

function getGameActiveKey(gameId) {
    return `gameActive:${gameId}`;
}

function getCountdownKey(gameId) {
    return `countdown:${gameId}`;
}

function getActiveDrawLockKey(gameId) {
    return `activeDrawLock:${gameId}`;
}

function getGameDrawStateKey(gameId) {
    return `gameDrawState:${gameId}`;
}

function getGameDrawsKey(gameId) {
    return `gameDraws:${gameId}`;
}

function getGameSessionIdKey(gameId) {
    return `gameSessionId:${gameId}`;
}

function getGamePlayersKey(gameId) {
    return `gamePlayers:${gameId}`; // Overall players for the game instance
}

function getGameRoomsKey(gameIdOrSessionId) { 
    return `gameRooms:${gameIdOrSessionId}`; // Players currently in the active game room
}

function getCardsKey(strGameId) {
    return `gameCards:${strGameId}`; // Players currently in the active game room
}

// Add any other Redis key helpers you might need
function getUserBalanceKey(telegramId) {
    return `userBalance:${telegramId}`;
}

function getActiveSocketKey(telegramId, socketId) {
    return `activeSocket:${telegramId}:${socketId}`;
}

function getUserSelectionsByTelegramIdKey() 
{ 
    return `userSelectionsByTelegramId`;

 }


module.exports = {
    getGameActiveKey,
    getCountdownKey,
    getActiveDrawLockKey,
    getGameDrawStateKey,
    getGameDrawsKey,
    getGameSessionIdKey,
    getGamePlayersKey,
    getGameRoomsKey,
    getUserBalanceKey,
    getActiveSocketKey,
    getCardsKey,
    getUserSelectionsByTelegramIdKey,
};