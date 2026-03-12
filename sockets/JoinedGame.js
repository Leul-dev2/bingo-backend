const GameControl     = require("../models/GameControl");
const PlayerSession   = require("../models/PlayerSession");
const { getGameDrawsKey } = require("../utils/redisKeys");

module.exports = function JoinedGameHandler(socket, io, redis) {
    socket.on("joinGame", async ({ gameId, GameSessionId, userHeldCardId }) => {
        // ─── FIX P0: Use server-verified identity — ignore client-supplied telegramId ──
        // socket.data.telegramId is set by JoinedLobbyHandler after Telegram
        // initData verification. Trusting the client payload here would allow
        // any player to impersonate another by sending a crafted telegramId.
        const strTelegramId    = socket.data.telegramId;
        const strGameId        = String(gameId);
        const strGameSessionId = String(GameSessionId);

        if (!strTelegramId) {
            console.warn(`🚫 joinGame rejected: socket ${socket.id} has no verified telegramId (not authenticated via userJoinedGame)`);
            socket.emit("joinError", { message: "Not authenticated. Please rejoin the lobby first." });
            return;
        }

        console.log("joinGame is invoked 🔥🔥🔥 for", strTelegramId);

        try {
            const graceKey = `pendingDisconnect:${strTelegramId}:${strGameId}:joinGame`;
            if (await redis.del(graceKey)) {
                console.log(`✅ User ${strTelegramId} reconnected within Redis grace period`);
            }

            // ─── FIX P1: Pipeline parallel reads — was 3 sequential awaits ──────
            // Original code made 3 round-trips to DB/Redis sequentially.
            // Promise.all reduces this to a single concurrent batch.
            const [playerSessionRecord, currentGameControl] = await Promise.all([
                PlayerSession.findOne({
                    GameSessionId: strGameSessionId,
                    telegramId:    strTelegramId
                }).lean(),
                GameControl.findOne({ GameSessionId: strGameSessionId }).lean(),
            ]);
            // ─────────────────────────────────────────────────────────────────────

            // Membership check
            if (!playerSessionRecord) {
                console.warn(`🚫 Blocked user ${strTelegramId}: Player record not found in PlayerSession.`);
                socket.emit("joinError", { message: "You are not registered in this game session." });
                return;
            }

            // Game status check
            if (currentGameControl?.endedAt) {
                console.log(`🔄 Player ${strTelegramId} tried to join a game that has ended.`);
                const winnerRaw = await redis.get(`winnerInfo:${strGameSessionId}`);
                if (winnerRaw) {
                    socket.emit("winnerConfirmed", JSON.parse(winnerRaw));
                    console.log(`✅ Redirecting player ${strTelegramId} to winner page.`);
                } else {
                    socket.emit("gameEnd", { message: "The game has ended." });
                    console.log(`✅ Redirecting player ${strTelegramId} to home page.`);
                }
                return;
            }

            // Update connection status on reconnect
            const updatedSession = await PlayerSession.findOneAndUpdate(
                { _id: playerSessionRecord._id, status: 'disconnected' },
                { $set: { status: 'connected' } },
                { new: true }
            );
            if (updatedSession) {
                console.log(`👤 Player ${strTelegramId} reconnected. Status updated to 'connected'.`);
            } else {
                console.log(`👤 Player ${strTelegramId} was already 'connected'. Proceeding.`);
            }

            // Register active socket with 2-hour TTL
            const activeSocketKey = `activeSocket:${strTelegramId}:${socket.id}`;
            await redis.set(activeSocketKey, '1', 'EX', 7200);
            console.log(`Backend: Socket ${socket.id} for ${strTelegramId} set up with 2hr TTL.`);

            // Store joinGame phase socket info
            await redis.hSet(`joinGameSocketsInfo`, socket.id, JSON.stringify({
                telegramId:    strTelegramId,
                gameId:        strGameId,
                GameSessionId: strGameSessionId,
                phase:         'joinGame'
            }));
            console.log(`✅ Stored joinGame socket info for ${strTelegramId}`);

            // Add user to room
            await redis.sAdd(`gameRooms:${strGameId}`, strTelegramId);
            socket.join(strGameId);
            
            // ─── FIX: Increment Redis connectedCount (completes the counter system) ─────
            await redis.incr(`connectedCount:${strGameSessionId}`);
            console.log(`[COUNTER] Incremented connectedCount for session ${strGameSessionId}`);

            const playerCount = await redis.sCard(`gameRooms:${strGameId}`);
            io.to(strGameId).emit("playerCountUpdate", { gameId: strGameId, playerCount });
            console.log(`[joinGame] Player ${strTelegramId} rejoined game ${strGameId}, total players: ${playerCount}`);

            // Emit initial session details
            socket.emit("gameId", {
                gameId:        strGameId,
                GameSessionId: strGameSessionId,
                telegramId:    strTelegramId,
            });

            // Send historical drawn numbers if game is active
            const gameDrawsKey    = getGameDrawsKey(strGameSessionId);
            const drawnNumbersRaw = await redis.lRange(gameDrawsKey, 0, -1);
            if (drawnNumbersRaw.length > 0) {
                const drawnNumbers          = drawnNumbersRaw.map(Number);
                const formattedDrawnNumbers = drawnNumbers.map(number => {
                    const letterIndex = Math.floor((number - 1) / 15);
                    const letter      = ["B", "I", "N", "G", "O"][letterIndex];
                    return { number, label: `${letter}-${number}` };
                });
                socket.emit("drawnNumbersHistory", {
                    gameId:        strGameId,
                    GameSessionId: strGameSessionId,
                    history:       formattedDrawnNumbers,
                });
                console.log(`[joinGame] Sent historical drawn numbers to ${strTelegramId}.`);
            }

        } catch (err) {
            console.error("❌ Database or Redis error in joinGame:", err);
            socket.emit("joinError", { message: "Failed to join game. Please refresh or retry." });
        }
    });
};
