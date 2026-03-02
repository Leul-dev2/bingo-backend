const { safeJsonParse } = require("../utils/safeJsonParse");
const ACTIVE_DISCONNECT_GRACE_PERIOD_MS = 2000;
const JOIN_GAME_GRACE_PERIOD_MS = 2000;
const { pendingDisconnectTimeouts } = require("../utils/timeUtils");

// 🔥 NEW IMPORTS — add these
const { queueUserUpdate } = require("../utils/emitBatcher");
const { dbQueue, defaultJobOptions } = require("../utils/dbQueue");

// 🔥 Paste the same LUA script you already use in cardSelection.js
const RELEASE_ALL_LUA = `
-- Release all cards for a user in a game
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
                console.log("❌ No relevant user session info found for this disconnected socket. Skipping cleanup.");
                return;
            }

            const strTelegramId = String(userPayload.telegramId);
            const strGameId = String(userPayload.gameId);

            console.log(`[DISCONNECT] Processing disconnect for User: ${strTelegramId}, Game: ${strGameId}, Phase: ${disconnectedPhase}, Session: ${strGameSessionId}`);

            await redis.del(`activeSocket:${strTelegramId}:${socket.id}`);

            const allActiveSocketKeysForUser = await redis.keys(`activeSocket:${strTelegramId}:*`);
            if (allActiveSocketKeysForUser.length > 0) {
                console.log(`[DISCONNECT] User ${strTelegramId} still has other active sockets. No cleanup timer started.`);
                return;
            }
            
            const timeoutKeyForPhase = `${strTelegramId}:${strGameId}:${disconnectedPhase}`;
            if (pendingDisconnectTimeouts.has(timeoutKeyForPhase)) {
                clearTimeout(pendingDisconnectTimeouts.get(timeoutKeyForPhase));
                pendingDisconnectTimeouts.delete(timeoutKeyForPhase);
            }

            let gracePeriodDuration = 0;
            if (disconnectedPhase === 'lobby') {
                gracePeriodDuration = ACTIVE_DISCONNECT_GRACE_PERIOD_MS;
            } else if (disconnectedPhase === 'joinGame') {
                gracePeriodDuration = JOIN_GAME_GRACE_PERIOD_MS;
            }

            // 🔥 UPDATED TIMEOUT — now releases cards + notifies frontend + queues DB worker
            if (gracePeriodDuration > 0) {
                const timeoutId = setTimeout(async () => {
                    try {
                        const cleanupJob = JSON.stringify({
                            telegramId: strTelegramId,
                            gameId: strGameId,
                            gameSessionId: strGameSessionId,
                            phase: disconnectedPhase,
                            timestamp: new Date().toISOString()
                        });

                        await redis.lPush('disconnect-cleanup-queue', cleanupJob);
                        console.log(`[DEFERRED] Pushed cleanup job to queue for User: ${strTelegramId}, Phase: ${disconnectedPhase}`);

                        // 🔥 RELEASE ALL CARDS FROM REDIS + BATCHER + DB WORKER
                        const released = await redis.eval(RELEASE_ALL_LUA, {
                            keys: [
                                `takenCards:${strGameId}`,
                                `userHeldCards:${strGameId}:${strTelegramId}`,
                                `gameCards:${strGameId}`
                            ]
                        });

                        if (Array.isArray(released) && released.length > 0) {
                            // 1. Immediate UI update for everyone (fixes 2-card yellow bug)
                            queueUserUpdate(strGameId, strTelegramId, [], released, io);
                            console.log(`🔄 Released ALL ${released.length} cards for ${strTelegramId} (disconnect / second mobile)`);

                            // 2. Queue persistent DB update via your existing dbWorker
                            await dbQueue.add('db-write', {
                                type: 'RELEASE_CARDS',
                                payload: { gameId: strGameId, cardIds: released }
                            }, { ...defaultJobOptions, priority: 2 });

                            console.log(`📤 Queued RELEASE_CARDS job to dbWorker for ${released.length} cards`);
                        }

                    } catch (e) {
                        console.error(`❌ Error in disconnect cleanup for ${strTelegramId}:`, e);
                    } finally {
                        pendingDisconnectTimeouts.delete(timeoutKeyForPhase);
                    }
                }, gracePeriodDuration);

                pendingDisconnectTimeouts.set(timeoutKeyForPhase, timeoutId);
                console.log(`🕒 Starting ${gracePeriodDuration / 1000}s grace period for ${strTelegramId} in phase '${disconnectedPhase}'.`);
            }
        } catch (e) {
            console.error(`❌ CRITICAL ERROR in disconnect handler for socket ${socket.id}:`, e);
        }
    });
};