// sockets/gameCount.js
//
// What changed from the previous version:
//
//   BEFORE: setInterval(tick, 1000) stored in state.countdownIntervals[gameId]
//           — dies silently if this process crashes; game freezes forever.
//
//   AFTER:  Enqueues a single COUNTDOWN_TICK BullMQ job (delay=0).
//           The timerWorker process processes it, decrements the Redis counter,
//           and re-enqueues the next tick with delay=1000ms.
//           If any process crashes, BullMQ restarts the next scheduled tick
//           automatically as soon as the worker comes back.
//
//   state.countdownIntervals is no longer written here.
//   It is kept in fullGameCleanup/resetGame for backward compatibility but
//   will always be empty — those clearInterval calls are now no-ops.

const { acquireGameLock }               = require("../utils/acquireGameLock");
const { getCountdownKey }               = require("../utils/redisKeys");
const { isGameLockedOrActive }          = require("../utils/isGameLockedOrActive");
const { prepareNewGame }                = require("../utils/PrepareNewGame");
const { fullGameCleanup }               = require("../utils/fullGameCleanup");
const { checkRateLimit }                = require("../utils/rateLimiter");
const { timerQueue, JOBS }              = require("../utils/timerQueue");

const MIN_PLAYERS_TO_START = 2;

module.exports = function GameCountHandler(socket, io, redis, state) {
    socket.on("gameCount", async ({ gameId, GameSessionId }) => {
        // Use server-verified identity
        const verifiedTelegramId = socket.data.telegramId;
        if (!verifiedTelegramId) {
            socket.emit("gameNotStarted", { message: "Not authenticated." });
            return;
        }

        const strGameId        = String(gameId);
        const strGameSessionId = String(GameSessionId);

        // Rate-limit: 3 triggers per 10 seconds per player per game
        const rateKey = `rate:gameCount:${verifiedTelegramId}:${strGameId}`;
        const allowed = await checkRateLimit(redis, rateKey, 3, 10);
        if (!allowed) {
            console.warn(`🚫 gameCount rate-limited for ${verifiedTelegramId}`);
            return;
        }

        // Socket must be a room member
        if (!socket.rooms.has(strGameId)) {
            socket.emit("gameNotStarted", { message: "Unauthorized: you are not in this game room." });
            return;
        }

        try {
            // ── Prevent double countdown ──────────────────────────────────────
            const countdownOwnerKey = `lock:countdownOwner:${strGameId}`;
            const ownerLock = await redis.set(countdownOwnerKey, "1", { NX: true, EX: 40 });
            if (!ownerLock) {
                console.log(`⏳ Countdown already owned for ${strGameId}`);
                return;
            }

            if (await isGameLockedOrActive(strGameId, redis, state)) {
                console.log(`⚠️ Game ${strGameId} already active/locked`);
                await redis.del(countdownOwnerKey);
                return;
            }

            const lockAcquired = await acquireGameLock(strGameId, redis, state);
            if (!lockAcquired) {
                await redis.del(countdownOwnerKey);
                return;
            }

            const countdownLockKey = `countdown:${strGameId}`;
            const countdownLock    = await redis.set(countdownLockKey, "1", { NX: true, EX: 35 });
            if (!countdownLock) {
                await redis.del(countdownOwnerKey);
                return;
            }

            // ── Player count check via Redis counter (no MongoDB query) ────────
            const connectedCountRaw    = await redis.get(`connectedCount:${strGameSessionId}`);
            const connectedPlayersCount = Number(connectedCountRaw) || 0;

            if (connectedPlayersCount < MIN_PLAYERS_TO_START) {
                console.log(`🛑 Not enough players (${connectedPlayersCount})`);
                io.to(strGameId).emit("gameNotStarted", { message: "Not enough connected players." });
                await fullGameCleanup(strGameId, redis, state);
                await redis.del(countdownLockKey);
                await redis.del(countdownOwnerKey);
                return;
            }

            await prepareNewGame(strGameId, strGameSessionId, redis, state);

            // ── Seed Redis countdown and emit first tick ───────────────────────
            const COUNTDOWN_SECONDS = 30;
            await redis.set(getCountdownKey(strGameId), String(COUNTDOWN_SECONDS));
            io.to(strGameId).emit("countdownTick", { countdown: COUNTDOWN_SECONDS });

            // ── Enqueue first COUNTDOWN_TICK job ──────────────────────────────
            // timerWorker will decrement every second, re-enqueuing the next
            // tick until it reaches 0, then enqueues GAME_START.
            // No setInterval. No in-memory state. Survives process crashes.
            await timerQueue.add(
                JOBS.COUNTDOWN_TICK,
                { gameId: strGameId, gameSessionId: strGameSessionId },
                {
                    delay:            1000,
                    jobId:            `countdown:${strGameId}:${COUNTDOWN_SECONDS - 1}`,
                    attempts:         1,
                    removeOnComplete: 1,
                    removeOnFail:     10,
                }
            );
            io.to(strGameId).emit("gameStatusChanged", { status: "starting", playerCount: connectedPlayersCount });

            console.log(`✅ Countdown enqueued for game ${strGameId} (${COUNTDOWN_SECONDS}s)`);

        } catch (err) {
            console.error(`❌ Fatal error in gameCount for ${strGameId}:`, err);
            io.to(strGameId).emit("gameNotStarted", { message: "Error during setup." });
            await fullGameCleanup(strGameId, redis, state);
            await redis.del(`lock:countdownOwner:${strGameId}`);
        }
    });
};
