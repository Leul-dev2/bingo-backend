const { acquireGameLock }               = require("../utils/acquireGameLock");
const { getCountdownKey }               = require("../utils/redisKeys");
const { isGameLockedOrActive }          = require("../utils/isGameLockedOrActive");
const { prepareNewGame }                = require("../utils/PrepareNewGame");
const { processDeductionsAndStartGame } = require("../utils/processDeductionAndStartGame");
const { fullGameCleanup }               = require("../utils/fullGameCleanup");
const { checkRateLimit }                = require("../utils/rateLimiter");

const MIN_PLAYERS_TO_START = 2;

module.exports = function GameCountHandler(socket, io, redis, state) {
    socket.on("gameCount", async ({ gameId, GameSessionId }) => {
        // ─── FIX P0: Use server-verified identity ─────────────────────────────
        const verifiedTelegramId = socket.data.telegramId;
        if (!verifiedTelegramId) {
            console.warn(`🚫 gameCount rejected: socket ${socket.id} has no verified telegramId`);
            socket.emit("gameNotStarted", { message: "Not authenticated." });
            return;
        }

        const strGameId        = String(gameId);
        const strGameSessionId = String(GameSessionId);

        // ─── FIX P2: Rate-limit gameCount to prevent Redis lock spam ──────────
        const rateKey = `rate:gameCount:${verifiedTelegramId}:${strGameId}`;
        const allowed = await checkRateLimit(redis, rateKey, 3, 10);
        if (!allowed) {
            console.warn(`🚫 gameCount rate-limited for ${verifiedTelegramId}`);
            return;
        }

        console.log("gameCount gamesessionId", GameSessionId);

        // ─── FIX P1: Verify the socket actually belongs to this game room ──────
        if (!socket.rooms.has(strGameId)) {
            console.warn(`🚫 Socket ${socket.id} tried to trigger gameCount for room ${strGameId} but is not a member.`);
            socket.emit("gameNotStarted", { message: "Unauthorized: you are not in this game room." });
            return;
        }

        try {
            // Prevent double countdown
            const countdownOwnerKey = `lock:countdownOwner:${strGameId}`;
            const ownerLock = await redis.set(countdownOwnerKey, "1", { NX: true, EX: 40 });
            if (!ownerLock) {
                console.log(`⏳ Countdown for game ${strGameId} is already owned by another process. Ignoring.`);
                return;
            }

            if (await isGameLockedOrActive(strGameId, redis, state)) {
                console.log(`⚠️ Game ${strGameId} is already active or locked.`);
                await redis.del(countdownOwnerKey);
                return;
            }

            const lockAcquired = await acquireGameLock(strGameId, redis, state);
            if (!lockAcquired) {
                console.log(`⚠️ Failed to acquire game lock for ${strGameId}.`);
                await redis.del(countdownOwnerKey);
                return;
            }

            const countdownLockKey = `countdown:${strGameId}`;
            const countdownLock    = await redis.set(countdownLockKey, "1", { NX: true, EX: 35 });
            if (!countdownLock) {
                console.log(`⏳ Countdown already running in Redis.`);
                await redis.del(countdownOwnerKey);
                return;
            }

            // ─── FIX P0: Redis counter instead of MongoDB count query ─────────
            // Original: PlayerSession.countDocuments() — a MongoDB query that fires
            // on every countdown trigger. Under 500+ concurrent games this becomes
            // a continuous DB query storm.
            //
            // Fix: maintain an in-Redis counter incremented on join / decremented
            // on leave. This is an O(1) Redis GET instead of a full collection scan.
            //
            // Counter is managed by:
            //   JoinedGame.js:   redis.incr(`connectedCount:${GameSessionId}`)  on join
            //   playerLeave.js:  redis.decr(`connectedCount:${GameSessionId}`)  on leave
            //   disconnect.js:   redis.decr(`connectedCount:${GameSessionId}`)  on disconnect cleanup
            //   fullGameCleanup: redis.del(`connectedCount:${GameSessionId}`)   on reset
            //
            // Fall back to 0 if key missing (game not yet populated).
            const connectedCountRaw    = await redis.get(`connectedCount:${strGameSessionId}`);
            const connectedPlayersCount = Number(connectedCountRaw) || 0;
            // ─────────────────────────────────────────────────────────────────

            if (connectedPlayersCount < MIN_PLAYERS_TO_START) {
                console.log(`🛑 Not enough players (${connectedPlayersCount})`);
                io.to(strGameId).emit("gameNotStarted", { message: "Not enough connected players." });
                await fullGameCleanup(strGameId, redis, state);
                await redis.del(countdownLockKey);
                await redis.del(countdownOwnerKey);
                return;
            }

            await prepareNewGame(strGameId, strGameSessionId, redis, state);

            // ── Start countdown ───────────────────────────────────────────────
            let countdownValue = 30;
            io.to(strGameId).emit("countdownTick", { countdown: countdownValue });
            await redis.set(getCountdownKey(strGameId), countdownValue.toString());

            // NOTE (P0 medium effort): state.countdownIntervals is in-memory.
            // This works on a SINGLE Node process because only one process can
            // own the countdownOwnerKey lock at a time.
            // To support N processes, migrate this interval to a BullMQ
            // repeatable job (1-second delay) so the timer survives restarts.
            state.countdownIntervals[strGameId] = setInterval(async () => {
                if (countdownValue > 0) {
                    countdownValue--;
                    io.to(strGameId).emit("countdownTick", { countdown: countdownValue });
                    await redis.set(getCountdownKey(strGameId), countdownValue.toString());
                } else {
                    const gameStartingKey = `gameStarting:${strGameId}`;
                    const setNXResult     = await redis.set(gameStartingKey, "1", { NX: true, EX: 20 });

                    clearInterval(state.countdownIntervals[strGameId]);
                    delete state.countdownIntervals[strGameId];
                    await redis.del(getCountdownKey(strGameId));

                    if (setNXResult !== "OK") {
                        console.log(`Lost atomic start lock.`);
                        await redis.del(countdownLockKey);
                        await redis.del(countdownOwnerKey);
                        return;
                    }

                    console.log(`✅ Starting game ${strGameId}`);
                    await processDeductionsAndStartGame(strGameId, strGameSessionId, io, redis, state);

                    await redis.del(countdownLockKey);
                    await redis.del(countdownOwnerKey);
                }
            }, 1000);

        } catch (err) {
            console.error(`❌ Fatal error in gameCount for ${strGameId}:`, err);
            io.to(strGameId).emit("gameNotStarted", { message: "Error during setup." });
            await fullGameCleanup(strGameId, redis, state);
            await redis.del(`lock:countdownOwner:${strGameId}`);
        }
    });
};
