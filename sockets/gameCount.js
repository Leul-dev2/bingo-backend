 const { acquireGameLock } = require("../utils/acquireGameLock");
 const { getCountdownKey } = require("../utils/redisKeys");
 const { isGameLockedOrActive } = require("../utils/isGameLockedOrActive");
 const { prepareNewGame } = require("../utils/PrepareNewGame");
 const { processDeductionsAndStartGame } = require("../utils/processDeductionAndStartGame");
 const { fullGameCleanup } = require("../utils/fullGameCleanup");
 const PlayerSession = require("../models/PlayerSession");

 
 const MIN_PLAYERS_TO_START = 2;

  

  module.exports = function GameCountHandler(socket, io, redis, state) {
    io.on("gameCount", async ({ gameId, GameSessionId }) => {
        const strGameId = String(gameId);
        const strGameSessionId = String(GameSessionId);

        console.log("gameCount gamesessionId", GameSessionId);

        try {
            // --- 0. PREVENT DOUBLE COUNTDOWN ---
            if (state.countdownIntervals[strGameId]) {
                console.log(`⏳ Countdown for game ${strGameId} is already running. Ignoring new 'gameCount' trigger.`);
                return;
            }

                if (await isGameLockedOrActive(strGameId, redis, state)) {
                console.log(`⚠️ Game ${strGameId} is already active or locked. Ignoring gameCount event.`);
                return;
            }

            const lockAcquired = await acquireGameLock(strGameId, redis, state);

            if (!lockAcquired) {
                console.log(`⚠️ Failed to acquire lock for game ${strGameId}. Another process beat us to it.`);
                return; // 🛑 CRITICAL: Exit if the atomic lock failed
            }

            console.log(`🚀 Acquired lock for game ${strGameId}.`);

            // Optional Redis Countdown Lock (safety across multiple nodes)
            const countdownLockKey = `countdown:${strGameId}`;
            const countdownLock = await redis.set(countdownLockKey, "1", { NX: true, EX: 35 });
            if (!countdownLock) {
                console.log(`⏳ Countdown already running in Redis for game ${strGameId}. Exiting.`);
                return;
            }

            // --- 1. VALIDATE PLAYER COUNT ---
            const connectedPlayersCount = await PlayerSession.countDocuments({
                GameSessionId: strGameSessionId,
                status: 'connected'
            });

            if (connectedPlayersCount < MIN_PLAYERS_TO_START) {
                console.log(`🛑 Not enough players to start game ${strGameId}. Found: ${connectedPlayersCount}`);
                io.to(strGameId).emit("gameNotStarted", { message: "Not enough connected players to start the game." });
                await fullGameCleanup(strGameId, redis, state);
                await redis.del(countdownLockKey);
                return;
            }


            await prepareNewGame(strGameId, strGameSessionId, redis, state);

            // --- 2. START COUNTDOWN ---
            let countdownValue = 30;
            io.to(strGameId).emit("countdownTick", { countdown: countdownValue });
            await redis.set(getCountdownKey(strGameId), countdownValue.toString());

            state.countdownIntervals[strGameId] = setInterval(async () => {
                if (countdownValue > 0) {
                    countdownValue--;
                    io.to(strGameId).emit("countdownTick", { countdown: countdownValue });
                    await redis.set(getCountdownKey(strGameId), countdownValue.toString());
                } else {
                    // --- 3. COUNTDOWN ENDED: ATOMIC LOCK ---
                    const gameStartingKey = `gameStarting:${strGameId}`;
                    const setNXResult = await redis.set(gameStartingKey, "1", {
                        NX: true, // Only set if key does NOT exist
                        EX: 20    // Safety TTL
                    });

                    // Stop and clean interval regardless of lock result
                    clearInterval(state.countdownIntervals[strGameId]);
                    delete state.countdownIntervals[strGameId];
                    await redis.del(getCountdownKey(strGameId));

                    // Check lock result
                    if (setNXResult !== 'OK') {
                        console.log(`Lobby ${strGameId}: Lost atomic lock. Another worker is starting the game.`);
                    // await redis.del(countdownLockKey);
                        return;
                    }

                    console.log(`Lobby ${strGameId}: Successfully acquired atomic lock. Starting the game process.`);

                    // --- 4. START GAME ---
                    await processDeductionsAndStartGame(strGameId, strGameSessionId, io, redis, state);

                    // Cleanup countdown lock after game start
                    await redis.del(countdownLockKey);
                }
            }, 1000);

        } catch (err) {
            console.error(`❌ Fatal error in gameCount for ${strGameId}:`, err);
            io.to(strGameId).emit("gameNotStarted", { message: "Error during game setup." });
            await fullGameCleanup(strGameId, redis, state);
        }
    });
}