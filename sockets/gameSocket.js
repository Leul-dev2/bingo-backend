// ─── FIX P0: Added missing fullGameCleanup import (was causing runtime crash on admin terminate)
const { fullGameCleanup } = require("../utils/fullGameCleanup");

const JoinedLobbyHandler   = require("./JoinedLobby");
const cardSelectionHandler = require("./cardSelection");
const JoinedGameHandler    = require("./JoinedGame");
const GameCountHandler     = require("./gameCount");
const checkWinnerHandler   = require("./checkWinner");
const playerLeaveHandler   = require("./playerLeave");
const disconnectHandler    = require("./disconnect");

// ─── FIX P0: REMOVED duplicate Redis adapter import + registration ─────────────
// The adapter is already correctly attached in index.js with proper pub/sub clients.
// Re-registering it here using the same client for both pub AND sub was illegal:
// a client in subscribe mode cannot issue commands, causing silent message drops
// and ghost rooms under multi-process load.
// ──────────────────────────────────────────────────────────────────────────────

module.exports = function registerGameSocket(io, redis) {

  // ─── NOTE on state object ─────────────────────────────────────────────────
  // countdownIntervals and drawIntervals are intentionally kept here for
  // single-process backward compatibility.
  // FIX P0 (MEDIUM effort): migrate these to BullMQ delayed jobs or a dedicated
  // timer-worker process before running more than one Node instance.
  // The Redis locks (isGameLockedOrActive, countdownOwnerKey) already prevent
  // double-firing across processes; the in-memory clearInterval calls only
  // affect the local process that owns the interval.
  const state = {
    countdownIntervals:  {},
    drawIntervals:       {},
    drawStartTimeouts:   {},
    activeDrawLocks:     {},
    gameDraws:           {},
    gameSessionIds:      {},
    gameIsActive:        {},
    gameReadyToStart:    {},
  };

  // ─── Admin command subscriber ─────────────────────────────────────────────
  const subClient = redis.duplicate();

  // ─── FIX P1: Reconnect subClient on error with exponential back-off ───────
  let subReconnectDelay = 1000;
  async function connectSubClient() {
    try {
      await subClient.connect();
      subReconnectDelay = 1000; // reset on success
      console.log("👂 Redis Subscriber connected: Listening for ADMIN_COMMANDS");

      await subClient.subscribe("ADMIN_COMMANDS", async (message) => {
        let action;
        try {
          action = JSON.parse(message);
        } catch {
          console.error("❌ Invalid ADMIN_COMMANDS message:", message);
          return;
        }

        if (action.type === "FORCE_TERMINATE") {
          const targetRoom = String(action.gameId);
          console.log(`🚫 Termination signal for Room: ${targetRoom}`);

          // 1. Stop the drawing timer on this process
          if (state.drawIntervals[targetRoom]) {
            clearInterval(state.drawIntervals[targetRoom]);
            delete state.drawIntervals[targetRoom];
          }

          // 2. Emit to all processes via Redis adapter
          io.to(targetRoom).emit("force_game_end", {
            message: "The game session has been terminated by an administrator.",
          });

          // 3. Delay cleanup so frontend can receive the message first
        setTimeout(async () => {
            try {
                const sessionId = await redis.get(`gameSessionId:${targetRoom}`);
                if (sessionId) {
                    await resetRound(targetRoom, sessionId, null, io, state, redis);
                } else {
                    await fullGameCleanup(targetRoom, redis, state);
                }
                io.in(targetRoom).socketsLeave(targetRoom);
                console.log(`🧹 Cleanup complete for ${targetRoom}`);
            } catch (cleanupErr) {
                console.error(`❌ Cleanup error for ${targetRoom}:`, cleanupErr);
            }
        }, 1000);
        }
      });
    } catch (err) {
      console.error(`❌ Redis Subscriber failed (retrying in ${subReconnectDelay}ms):`, err);
      setTimeout(() => {
        subReconnectDelay = Math.min(subReconnectDelay * 2, 30000); // cap at 30s
        connectSubClient();
      }, subReconnectDelay);
    }
  }
  connectSubClient();

  io.on("connection", (socket) => {
    // ─── FIX P0: AUTH MIDDLEWARE PER SOCKET ───────────────────────────────
    // socket.data.telegramId is set by JoinedLobbyHandler after Telegram
    // initData verification. All subsequent handlers READ from socket.data
    // instead of trusting the client-provided telegramId payload.
    // This prevents any player from spoofing another player's identity
    // on cardSelected, checkWinner, gameCount, playerLeave, joinGame events.
    // ──────────────────────────────────────────────────────────────────────

    JoinedLobbyHandler (socket, io, redis);
    cardSelectionHandler(socket, io, redis);
    JoinedGameHandler  (socket, io, redis);
    GameCountHandler   (socket, io, redis, state);
    checkWinnerHandler (socket, io, redis, state);
    playerLeaveHandler (socket, io, redis, state);
    disconnectHandler  (socket, io, redis);
  });
};
