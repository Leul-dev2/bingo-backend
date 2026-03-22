const { safeJsonParse }              = require("../utils/safeJsonParse");
const { dbQueue, defaultJobOptions } = require("../utils/dbQueue");

const GRACE_SECONDS  = 10;
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
            await redis.set(graceKey, "1", { NX: true, EX: GRACE_SECONDS + 5 });
            console.log(`[GRACE] Set ${graceKey} → ${GRACE_SECONDS}s TTL`);

            // ADD immediately after setting grace key, before enqueuing BullMQ job:

// Immediate lightweight cleanup — runs NOW, not after grace period
            await Promise.all([
                redis.sRem(`gameRooms:${gameId}`,    telegramId),  // remove from room count immediately
                redis.sRem(`gameSessions:${gameId}`, telegramId),  // remove from session set
            ]);

            // Decrement connectedCount immediately so gameCount sees correct count
            if (gameSessionId && gameSessionId !== "NO_SESSION_ID") {
                await redis.decr(`connectedCount:${gameSessionId}`);
            }

            // Update PlayerSession to disconnected immediately
            const PlayerSession = require("../models/PlayerSession");
            await PlayerSession.updateOne(
                { GameSessionId: gameSessionId, telegramId },
                { $set: { status: "disconnected" } }
            ).catch(() => {}); // non-blocking, best effort

            // Broadcast updated player count
            const remainingCount = await redis.sCard(`gameRooms:${gameId}`);
            io.to(gameId).emit("playerCountUpdate", { gameId, playerCount: remainingCount });

            console.log(`[IMMEDIATE] Removed ${telegramId} from room — ${remainingCount} remaining`);

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
                    removeOnComplete: true,
                    removeOnFail: 100,
                },
            );

            console.log(`[GRACE] BullMQ disconnect-cleanup enqueued: ${jobId}`);

        } catch (err) {
            console.error(`[DISCONNECT CRITICAL] ${socket.id}:`, err);
        }
    });
};