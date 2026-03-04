const { acquireGameLock } = require("../utils/acquireGameLock");
const { getCountdownKey } = require("../utils/redisKeys");
const { isGameLockedOrActive } = require("../utils/isGameLockedOrActive");
const { prepareNewGame } = require("../utils/PrepareNewGame");
const { processDeductionsAndStartGame } = require("../utils/processDeductionAndStartGame");
const { fullGameCleanup } = require("../utils/fullGameCleanup");
const PlayerSession = require("../models/PlayerSession");

const MIN_PLAYERS_TO_START = 2;

module.exports = function GameCountHandler(socket, io, redis, state) {
    socket.on("gameCount", async ({ gameId, GameSessionId }) => {
        const strGameId = String(gameId);
        const strGameSessionId = String(GameSessionId);

        console.log("gameCount gamesessionId", GameSessionId);

        try {
            // ── PREVENT DOUBLE COUNTDOWN (Redis lock instead of in-memory state) ──
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

            // Optional Redis safety lock (kept from your original)
            const countdownLockKey = `countdown:${strGameId}`;
            const countdownLock = await redis.set(countdownLockKey, "1", { NX: true, EX: 35 });
            if (!countdownLock) {
                console.log(`⏳ Countdown already running in Redis.`);
                await redis.del(countdownOwnerKey);
                return;
            }

            // ── VALIDATE PLAYER COUNT ──
            const connectedPlayersCount = await PlayerSession.countDocuments({
                GameSessionId: strGameSessionId,
                status: 'connected'
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

            // ── START COUNTDOWN ──
            let countdownValue = 30;
            io.to(strGameId).emit("countdownTick", { countdown: countdownValue });
            await redis.set(getCountdownKey(strGameId), countdownValue.toString());

            state.countdownIntervals[strGameId] = setInterval(async () => {   // kept for backward compat inside single process
                if (countdownValue > 0) {
                    countdownValue--;
                    io.to(strGameId).emit("countdownTick", { countdown: countdownValue });
                    await redis.set(getCountdownKey(strGameId), countdownValue.toString());
                } else {
                    const gameStartingKey = `gameStarting:${strGameId}`;
                    const setNXResult = await redis.set(gameStartingKey, "1", { NX: true, EX: 20 });

                    clearInterval(state.countdownIntervals[strGameId]);
                    delete state.countdownIntervals[strGameId];
                    await redis.del(getCountdownKey(strGameId));

                    if (setNXResult !== 'OK') {
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