const { acquireGameLock }                  = require("../utils/acquireGameLock");
const { getCountdownKey }                  = require("../utils/redisKeys");
const { isGameLockedOrActive }             = require("../utils/isGameLockedOrActive");
const { prepareNewGame }                   = require("../utils/PrepareNewGame");
const { processDeductionsAndStartGame }    = require("../utils/processDeductionAndStartGame");
const { fullGameCleanup }                  = require("../utils/fullGameCleanup");
const PlayerSession                        = require("../models/PlayerSession");

const MIN_PLAYERS_TO_START = 2;

module.exports = function GameCountHandler(socket, io, redis, state) {
    socket.on("gameCount", async ({ gameId, GameSessionId }) => {
        const strGameId        = String(gameId);
        const strGameSessionId = String(GameSessionId);

        console.log("gameCount gamesessionId", GameSessionId);

        // ─── FIX P1: Verify the socket actually belongs to this game room ──────
        // Without this check, any socket — even one not in the room — could
        // trigger the countdown by sending a crafted gameCount event.
        if (!socket.rooms.has(strGameId)) {
            console.warn(`🚫 Socket ${socket.id} tried to trigger gameCount for room ${strGameId} but is not a member.`);
            socket.emit("gameNotStarted", { message: "Unauthorized: you are not in this game room." });
            return;
        }

        try {
            // ── Prevent double countdown (Redis lock instead of in-memory state) ──
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

            // ── Validate player count ─────────────────────────────────────────
            // FIX P1 (MEDIUM): For high-frequency paths, cache this count in Redis
            // using INCR/DECR on join/leave to avoid a MongoDB query every countdown.
            // Example:  const connectedPlayersCount = await redis.get(`connectedCount:${strGameSessionId}`);
            const connectedPlayersCount = await PlayerSession.countDocuments({
                GameSessionId: strGameSessionId,
                status: "connected",
            });

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
            // This works correctly on a SINGLE Node process because only one
            // process can own the countdownOwnerKey lock at a time.
            // To support N processes, migrate this interval to a BullMQ
            // repeatable job (1-second delay) so the timer survives process
            // restarts and is owned by your job worker — not a socket server.
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
