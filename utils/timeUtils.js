const pendingDisconnectTimeouts = new Map(); // Key: `${telegramId}:${gameId}`, Value: setTimeout ID
const ACTIVE_DISCONNECT_GRACE_PERIOD_MS = 1 * 1000; // For card selection lobby (10 seconds)
const JOIN_GAME_GRACE_PERIOD_MS = 2 * 1000; // For initial join/live game phase (5 seconds)
const ACTIVE_SOCKET_TTL_SECONDS = 60 * 3;

module.exports = {
  pendingDisconnectTimeouts,
  ACTIVE_DISCONNECT_GRACE_PERIOD_MS,
  JOIN_GAME_GRACE_PERIOD_MS,
  ACTIVE_SOCKET_TTL_SECONDS,
};