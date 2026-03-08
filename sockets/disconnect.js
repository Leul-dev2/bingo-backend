const { safeJsonParse } = require("../utils/safeJsonParse");
const { pendingDisconnectTimeouts } = require("../utils/timeUtils");

// 🔥 Required for card release + batching + DB worker
const { queueUserUpdate } = require("../utils/emitBatcher");
const { dbQueue, defaultJobOptions } = require("../utils/dbQueue");

const RELEASE_ALL_LUA = `
local takenKey = KEYS[1]
local userHeldKey = KEYS[2]
local gameCardsKey = KEYS[3]

local cards = redis.call("LRANGE", userHeldKey, 0, -1)
for _, cardId in ipairs(cards) do
    redis.call("SREM", takenKey, cardId)
    redis.call("HDEL", gameCardsKey, cardId)
end
redis.call("DEL", userHeldKey)

return cards
`;

module.exports = function disconnectHandler(socket, io, redis) {
    socket.on("disconnect", async (reason) => {
        console.log(`🔴 Client disconnected: ${socket.id}, Reason: ${reason}`);

        try {
            const [userSelectionPayloadRaw, joinGamePayloadRaw] = await redis.multi()
                .hGet("userSelections", socket.id)
                .hGet("joinGameSocketsInfo", socket.id)
                .exec();

            console.log(`JoinGame Payload Raw: ${joinGamePayloadRaw}, User Selection Payload Raw: ${userSelectionPayloadRaw}`);

            let userPayload = null;
            let disconnectedPhase = null;
            let strGameSessionId = 'NO_SESSION_ID';

            if (joinGamePayloadRaw) {
                userPayload = safeJsonParse(joinGamePayloadRaw, "joinGameSocketsInfo", socket.id);
                if (userPayload) {
                    disconnectedPhase = userPayload.phase || 'joinGame';
                    strGameSessionId = userPayload.GameSessionId || strGameSessionId;
                } else {
                    await redis.hDel("joinGameSocketsInfo", socket.id);
                }
            }

            if (!userPayload && userSelectionPayloadRaw) {
                userPayload = safeJsonParse(userSelectionPayloadRaw, "userSelections", socket.id);
                if (userPayload) {
                    disconnectedPhase = userPayload.phase || 'lobby';
                } else {
                    await redis.hDel("userSelections", socket.id);
                }
            }

            if (!userPayload || !userPayload.telegramId || !userPayload.gameId) {
                console.log("❌ No relevant user session info found. Skipping.");
                return;
            }

            const strTelegramId = String(userPayload.telegramId);
            const strGameId = String(userPayload.gameId);

            console.log(`[DISCONNECT] User: ${strTelegramId}, Game: ${strGameId}, Phase: ${disconnectedPhase}`);

            // Remove this specific socket from active list
            await redis.del(`activeSocket:${strTelegramId}:${socket.id}`);

            // Check if user has ANY remaining active sockets
            // (we no longer use keys(*) pattern — assume if this one is gone and no reconnect happened → cleanup)
            // If you want stricter check later, you can use a Redis set per user instead

            // ──────────────────────────────────────────────────────────────
            // FIX 1: Grace period using Redis key (no in-memory Map anymore)
            // ──────────────────────────────────────────────────────────────
            const graceKey = `pendingDisconnect:${strTelegramId}:${strGameId}:${disconnectedPhase}`;
            const graceSeconds = disconnectedPhase === 'lobby' ? 2 : 2; // ← adjust as needed (was 2s + jitter)

            // Set grace flag with TTL → if reconnect happens → it will be deleted
            await redis.set(graceKey, '1', 'EX', graceSeconds);
            console.log(`🕒 Grace period ${graceSeconds}s stored in Redis for ${strTelegramId} (phase: ${disconnectedPhase})`);

            // Schedule cleanup AFTER grace period expires
            // Note: we use a fixed delay slightly longer than TTL to be safe
            const cleanupDelay = (graceSeconds + 2) * 1000; // 2s buffer

            setTimeout(async () => {
                try {
                    // Check if grace key still exists → means no reconnect happened
                    const graceStillActive = await redis.get(graceKey);
                    if (!graceStillActive) {
                        console.log(`[GRACE CANCELLED] User ${strTelegramId} reconnected → skipping cleanup`);
                        return;
                    }

                    console.log(`[GRACE EXPIRED] Cleaning up disconnected user ${strTelegramId}`);


                    await redis.lPush('disconnect-cleanup-queue', JSON.stringify({
                            telegramId: strTelegramId,
                            gameId: strGameId,
                            gameSessionId: strGameSessionId,
                            phase: disconnectedPhase,
                            timestamp: new Date().toISOString()
                    }));

                    // RELEASE ALL CARDS
                    const released = await redis.eval(RELEASE_ALL_LUA, {
                        keys: [
                            `takenCards:${strGameId}`,
                            `userHeldCards:${strGameId}:${strTelegramId}`,
                            `gameCards:${strGameId}`
                        ]
                    });

                    if (Array.isArray(released) && released.length > 0) {
                        queueUserUpdate(strGameId, strTelegramId, [], released, io);
                        console.log(`🔄 Released ${released.length} cards for ${strTelegramId} (grace expired)`);

                        await dbQueue.add('db-write', {
                            type: 'RELEASE_CARDS',
                            payload: { gameId: strGameId, cardIds: released }
                        }, { ...defaultJobOptions, priority: 2 });

                        // Optional: update snapshot if you implemented it
                        await updateCardSnapshot(strGameId, redis);
                    }

                    // Clean up any remaining session tracking
                    await redis.del(graceKey);

                } catch (e) {
                    console.error(`❌ Disconnect cleanup error for ${strTelegramId}:`, e);
                }
            }, cleanupDelay);

        } catch (e) {
            console.error(`❌ CRITICAL ERROR in disconnect for ${socket.id}:`, e);
        }
    });
};