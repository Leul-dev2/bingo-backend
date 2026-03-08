const { safeJsonParse } = require("../utils/safeJsonParse");
const ACTIVE_DISCONNECT_GRACE_PERIOD_MS = 2000;
const JOIN_GAME_GRACE_PERIOD_MS = 2000;
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

            await redis.del(`activeSocket:${strTelegramId}:${socket.id}`);

            const allActiveSocketKeysForUser = await redis.keys(`activeSocket:${strTelegramId}:*`);
            if (allActiveSocketKeysForUser.length > 0) {
                console.log(`[DISCONNECT] User ${strTelegramId} still has other sockets. No cleanup.`);
                return;
            }
 
            const graceKey = `pendingDisconnect:${strTelegramId}:${strGameId}:${disconnectedPhase}`;
            const graceSeconds = disconnectedPhase === 'lobby' ? 5 : 5;

            // Set grace flag in Redis (auto-expires)
            await redis.set(graceKey, '1', 'EX', graceSeconds);
            console.log(`🕒 Grace period ${graceSeconds}s stored in Redis for ${strTelegramId}`);
            
        } catch (e) {
            console.error(`❌ CRITICAL ERROR in disconnect for ${socket.id}:`, e);
        }
    });
};