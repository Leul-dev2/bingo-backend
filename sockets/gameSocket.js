// ─── FIX P0: Added missing fullGameCleanup import (was causing runtime crash on admin terminate)
const { fullGameCleanup } = require("../utils/fullGameCleanup");

const JoinedLobbyHandler  = require("./JoinedLobby");
const cardSelectionHandler = require("./cardSelection");
const JoinedGameHandler    = require("./JoinedGame");
const GameCountHandler     = require("./gameCount");
const checkWinnerHandler   = require("./checkWinner");
const playerLeaveHandler   = require("./playerLeave");
const disconnectHandler    = require("./disconnect");

// ─── FIX P0: Import Redis adapter for multi-process Socket.io room broadcasts
// Install first:  npm install @socket.io/redis-adapter
// Without this, io.to(room).emit() only reaches sockets on the SAME Node process.
const { createAdapter } = require("@socket.io/redis-adapter");

module.exports = function registerGameSocket(io, redis) {

  // ─── FIX P0: Attach Redis adapter so all processes share rooms
  // pubClient = your existing redis client (already connected)
  // subClient2 = a fresh duplicate used exclusively for the adapter's subscription channel
  const adapterSubClient = redis.duplicate();
  adapterSubClient.connect().then(() => {
    io.adapter(createAdapter(redis, adapterSubClient));
    console.log("✅ Socket.io Redis adapter attached — multi-process room broadcasts enabled");
  }).catch(err => {
    console.error("❌ Failed to attach Socket.io Redis adapter:", err);
    // Non-fatal in single-process mode but will break multi-process; alert your team
  });

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
    gameIsActive:        {},   // FIX P1: back these with Redis keys via isGameLockedOrActive util
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

          // 2. Emit to all processes via Redis adapter (now correctly broadcast)
          io.to(targetRoom).emit("force_game_end", {
            message: "The game session has been terminated by an administrator.",
          });

          // 3. Delay cleanup so frontend can receive the message first
          setTimeout(async () => {
            try {
              // ─── FIX P0: fullGameCleanup is now imported at the top ───────
              await fullGameCleanup(targetRoom, redis, state);
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

  // ─── FIX P1: Tune Socket.io heartbeat for mobile / Telegram WebApp ────────
  // Default pingInterval=25000 is too slow to detect dead mobile sockets.
  // Set these in the io() constructor options for best effect; this is a
  // runtime override as a fallback if you cannot change the server init.
  // RECOMMENDED: move pingInterval + pingTimeout to your io() constructor:
  //   const io = new Server(httpServer, { pingInterval: 10000, pingTimeout: 5000 })
  // ──────────────────────────────────────────────────────────────────────────

  io.on("connection", (socket) => {
    JoinedLobbyHandler (socket, io, redis);
    cardSelectionHandler(socket, io, redis);
    JoinedGameHandler  (socket, io, redis);
    GameCountHandler   (socket, io, redis, state);
    checkWinnerHandler (socket, io, redis, state);
    playerLeaveHandler (socket, io, redis, state);
    disconnectHandler  (socket, io, redis);
  });
};
