const { pendingDisconnectTimeouts, ACTIVE_SOCKET_TTL_SECONDS } = require("../utils/timeUtils");
const { verifyTelegramWithCache } = require("../utils/verifyWithCache");
const { checkRateLimit }          = require("../utils/rateLimiter");
const { getCountdownKey }         = require("../utils/redisKeys");

module.exports = function JoinedLobbyHandler(socket, io, redis) {
    socket.on("userJoinedGame", async ({ initData, gameId }) => {
        console.log("userJoined invoked");

        const verifiedUser = await verifyTelegramWithCache(
            initData,
            process.env.TELEGRAM_BOT_TOKEN,
            redis
        );

        if (!verifiedUser) {
            socket.emit("joinError", { message: "Unauthorized user" });
            return;
        }

        // ─── FIX P0: Store verified identity server-side ──────────────────────
        // All subsequent socket handlers (cardSelected, checkWinner, gameCount,
        // playerLeave, joinGame) must read telegramId from socket.data — NEVER
        // from the client event payload, which is trivially spoofable.
        socket.data.telegramId = String(verifiedUser.telegramId);
        socket.data.gameId     = String(gameId);
        console.log(`✅ Verified and stored socket.data for ${socket.data.telegramId}`);
        // ─────────────────────────────────────────────────────────────────────

        const rateKey = `rate:join:${verifiedUser.telegramId}`;
        const allowed = await checkRateLimit(redis, rateKey, 3, 10);
        if (!allowed) {
            socket.emit("joinError", { message: "Too many requests. Slow down." });
            return;
        }

        const strTelegramId = String(verifiedUser.telegramId);
        const strGameId     = String(gameId);
        const multi         = redis.multi();

        console.log("✅ Verified Telegram user:", strTelegramId);

        try {
            const userSelectionKey        = `userSelections`;
            const userOverallSelectionKey = `userSelectionsByTelegramId`;
            const gameCardsKey            = `gameCards:${strGameId}`;
            const userHeldCardsKey        = `userHeldCards:${strGameId}:${strTelegramId}`;
            const sessionKey              = `gameSessions:${strGameId}`;
            const gamePlayersKey          = `gamePlayers:${strGameId}`;

            console.log(`Backend: Processing userJoinedGame for Telegram ID: ${strTelegramId}, Game ID: ${strGameId}`);

            // --- Step 1: Handle Disconnect Grace Period Timer Cancellation ---
            const graceKey = `pendingDisconnect:${strTelegramId}:${strGameId}:lobby`;
            if (await redis.del(graceKey)) {
                console.log(`✅ User ${strTelegramId} reconnected within Redis grace period`);
            } else {
                console.log(`🆕 User ${strTelegramId} joining game ${strGameId}. No pending disconnect timeout found.`);
            }

            // --- Clean up residual 'joinGame' phase info ---
            await redis.hDel(`joinGameSocketsInfo`, socket.id);
            console.log(`🧹 Cleaned up residual 'joinGameSocketsInfo' for socket ${socket.id}.`);

            // --- Step 2: Determine Current Card State for Reconnecting Player ---
            let currentHeldCardId = null;
            let currentHeldCard   = null;

            const userOverallSelectionRaw = await redis.hGet(userOverallSelectionKey, strTelegramId);
            if (userOverallSelectionRaw) {
                const overallSelection = JSON.parse(userOverallSelectionRaw);
                if (String(overallSelection.gameId) === strGameId && overallSelection.cardId !== null) {
                    const isMember = await redis.sIsMember(userHeldCardsKey, String(overallSelection.cardId));
                    console.log(`cardOwner check for ➖➖🛑 ${strTelegramId}:`, cardOwner);
                    if (isMember) {
                        currentHeldCardId = overallSelection.cardId;
                        currentHeldCard   = overallSelection.card;
                        console.log(`✅ User ${strTelegramId} reconnected with previously held card ${currentHeldCardId}.`);
                    } else {
                        console.log(`⚠️ User ${strTelegramId} stale card entry. Cleaning up.`);
                        await redis.hDel(userOverallSelectionKey, strTelegramId);
                    }
                } else {
                    console.log(`ℹ️ User ${strTelegramId} had overall selection for a different game or no card.`);
                }
            } else {
                console.log(`ℹ️ No overall persisted selection found for ${strTelegramId}.`);
            }

            // --- Step 3: Set up socket and persist selection state ---
            await redis.set(`activeSocket:${strTelegramId}:${socket.id}`, '1', 'EX', ACTIVE_SOCKET_TTL_SECONDS);
            socket.join(strGameId);

            multi.hSet(userSelectionKey, socket.id, JSON.stringify({
                telegramId: strTelegramId,
                gameId:     strGameId,
                cardId:     currentHeldCardId,
                card:       currentHeldCard,
                phase:      'lobby'
            }));
            console.log(`Backend: Socket ${socket.id} for ${strTelegramId} set up with cardId: ${currentHeldCardId || 'null'} in 'lobby' phase.`);

            // --- Step 4: Add user to Redis Sets ---
            multi.sAdd(sessionKey,     strTelegramId);
            multi.sAdd(gamePlayersKey, strTelegramId);
            multi.sCard(sessionKey);

            const results = await multi.exec();

            // --- Step 5: Broadcast Current Lobby State ---
            const numberOfPlayersInLobby = results[3];
            console.log(`Backend: Calculated numberOfPlayers for ${sessionKey}: ${numberOfPlayersInLobby}`);

            io.to(strGameId).emit("gameid", {
                gameId:          strGameId,
                numberOfPlayers: numberOfPlayersInLobby,
            });

            // --- Step 6: Send cached card-state snapshot ---
            const snapshotKey = `cardStateSnapshot:${strGameId}`;
            const snapshotRaw = await redis.get(snapshotKey);

            if (snapshotRaw) {
                const initialCardsState = JSON.parse(snapshotRaw);
                socket.emit("initialCardStates", { takenCards: initialCardsState });
                console.log(`✅ Sent cached snapshot (${Object.keys(initialCardsState).length} cards) to ${strTelegramId}`);
            } else {
                socket.emit("initialCardStates", { takenCards: {} });
                console.log(`✅ Sent empty snapshot to ${strTelegramId}`);
            }

                const [gameIsActive, gameStarting, countdownRaw, roomCount] = await Promise.all([
                    redis.get(`gameIsActive:${strGameId}`),
                    redis.get(`gameStarting:${strGameId}`),
                    redis.get(getCountdownKey(strGameId)),
                    redis.sCard(`gameRooms:${strGameId}`),
                ]);

                const playerCount = Number(roomCount) || 0;
                let status = "open";
                if (gameIsActive === "true") status = "active";
                else if (gameStarting || (countdownRaw !== null && Number(countdownRaw) > 0)) status = "starting";

                socket.emit("gameStatusChanged", { 
                    status, 
                    playerCount,
                    countdown: countdownRaw !== null ? Number(countdownRaw) : null,
                });

        } catch (err) {
            console.error("❌ Error in userJoinedGame:", err);
            socket.emit("joinError", { message: "Failed to join game. Please refresh or retry." });
        }
    });
};
