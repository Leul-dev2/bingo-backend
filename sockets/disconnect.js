const { safeJsonParse }              = require("../utils/safeJsonParse");
const { dbQueue, defaultJobOptions } = require("../utils/dbQueue");

const GRACE_SECONDS  = 20;
const GRACE_DELAY_MS = GRACE_SECONDS * 1000 + 600;

module.exports = function disconnectHandler(socket, io, redis) {
    socket.on("disconnect", async (reason) => {
        console.log(`🔴 Client disconnected: ${socket.id}, Reason: ${reason}`);

        try {
            const [userSelectionRaw, joinGameRaw] = await redis.multi()
                .hGet("userSelections",      socket.id)
                .hGet("joinGameSocketsInfo", socket.id)
                .exec();

            let userPayload   = null;
            let phase         = null;
            let gameSessionId = "NO_SESSION_ID";

            if (joinGameRaw) {
                userPayload = safeJsonParse(joinGameRaw, "joinGameSocketsInfo", socket.id);
                if (userPayload) {
                    phase         = userPayload.phase || "joinGame";
                    gameSessionId = userPayload.GameSessionId || gameSessionId;
                } else {
                    await redis.hDel("joinGameSocketsInfo", socket.id);
                }
            }

            if (!userPayload && userSelectionRaw) {
                userPayload = safeJsonParse(userSelectionRaw, "userSelections", socket.id);
                if (userPayload) {
                    phase = userPayload.phase || "lobby";
                } else {
                    await redis.hDel("userSelections", socket.id);
                }
            }

            if (!userPayload || !userPayload.telegramId || !userPayload.gameId) {
                console.log("❌ No session info found → skipping cleanup");
                return;
            }

            const telegramId    = String(userPayload.telegramId);
            const gameId        = String(userPayload.gameId);
            const resolvedPhase = phase === "joinGame" ? "joinGame" : "lobby";

            console.log(`[DISCONNECT] ${telegramId} in game ${gameId} (phase: ${resolvedPhase})`);

            await redis.del(`activeSocket:${telegramId}:${socket.id}`);

            const graceKey = `pendingDisconnect:${telegramId}:${gameId}:${resolvedPhase}`;
            await redis.set(graceKey, "1", { NX: true, EX: GRACE_SECONDS });
            console.log(`[GRACE] Set ${graceKey} → ${GRACE_SECONDS}s TTL`);

            // Enqueue cleanup job in BullMQ — runs in dbWorker after grace period
            const jobId = `disconnect-${telegramId}-${gameId}-${resolvedPhase}`;
            await dbQueue.add(
                "disconnect-cleanup",
                {
                    telegramId,
                    gameId,
                    gameSessionId,
                    resolvedPhase,
                    graceKey,
                    socketId: socket.id,
                },
                {
                    ...defaultJobOptions,
                    delay:    GRACE_DELAY_MS,
                    jobId,
                    attempts: 2,
                    priority: 3,
                }
            );

            console.log(`[GRACE] BullMQ disconnect-cleanup enqueued: ${jobId}`);

        } catch (err) {
            console.error(`[DISCONNECT CRITICAL] ${socket.id}:`, err);
        }
    });
};