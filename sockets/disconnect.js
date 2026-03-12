const { safeJsonParse }    = require("../utils/safeJsonParse");
const { queueUserUpdate }  = require("../utils/emitBatcher");
const { dbQueue, defaultJobOptions } = require("../utils/dbQueue");
const { updateCardSnapshot } = require("../utils/updateCardSnapshot");

// ─── Lua: release all cards + clean ownership map atomically ─────────────────
const RELEASE_ALL_LUA = `
local takenKey     = KEYS[1]
local userHeldKey  = KEYS[2]
local gameCardsKey = KEYS[3]

local cards = redis.call("LRANGE", userHeldKey, 0, -1)
for _, cardId in ipairs(cards) do
    redis.call("SREM", takenKey,    cardId)
    redis.call("HDEL", gameCardsKey, cardId)
end
redis.call("DEL", userHeldKey)

return cards
`;

module.exports = function disconnectHandler(socket, io, redis) {
    socket.on("disconnect", async (reason) => {
        console.log(`🔴 Client disconnected: ${socket.id}, Reason: ${reason}`);

        try {
            const [userSelectionRaw, joinGameRaw] = await redis.multi()
                .hGet("userSelections",     socket.id)
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

            const telegramId = String(userPayload.telegramId);
            const gameId     = String(userPayload.gameId);

            console.log(`[DISCONNECT] ${telegramId} in game ${gameId} (phase: ${phase})`);

            await redis.del(`activeSocket:${telegramId}:${socket.id}`);

            // ─── FIX P0: Grace period increased from 2s → 20s ────────────────
            // Telegram mobile on 4G can take 5–10 seconds to reconnect after a
            // network blip or app backgrounding. A 2-second window was triggering
            // false card releases on live players constantly.
            // 20 seconds covers the 99th percentile mobile reconnect time while
            // keeping the Redis key size trivial (just a string with TTL).
            const graceKey     = `pendingDisconnect:${telegramId}:${gameId}:${phase || "unknown"}`;
            const graceSeconds = 20; // was 2 — increased for mobile reconnect

            await redis.set(graceKey, "1", "EX", graceSeconds);
            console.log(`[GRACE] Set ${graceKey} → ${graceSeconds}s TTL`);

            const cleanupDelay = graceSeconds * 1000 + 600; // 600ms accuracy buffer

            setTimeout(async () => {
                try {
                    console.log(`[TIMEOUT FIRED] Cleanup for ${telegramId} after ${cleanupDelay}ms`);

                    const graceStillActive = await redis.get(graceKey);
                    if (!graceStillActive) {
                        console.log(`[GRACE CANCELLED] ${telegramId} reconnected → skipping cleanup`);
                        return;
                    }

                    console.log(`[GRACE EXPIRED] Processing disconnect cleanup for ${telegramId}`);

                    const released = await redis.eval(RELEASE_ALL_LUA, {
                        keys: [
                            `takenCards:${gameId}`,
                            `userHeldCards:${gameId}:${telegramId}`,
                            `gameCards:${gameId}`,
                        ],
                    });

                    console.log(`[RELEASE RESULT] ${telegramId} → ${JSON.stringify(released)}`);

                    if (Array.isArray(released) && released.length > 0) {
                        queueUserUpdate(gameId, telegramId, [], released, io);
                        console.log(`[BATCH] Queued UI release for ${released.length} cards`);

                        await dbQueue.add(
                            "db-write",
                            { type: "RELEASE_CARDS", payload: { gameId, cardIds: released } },
                            { ...defaultJobOptions, priority: 2 }
                        );

                        await updateCardSnapshot(gameId, redis);
                        console.log(`[SNAPSHOT] Updated after release for game ${gameId}`);
                    } else {
                        console.log(`[NO CARDS TO RELEASE] for ${telegramId}`);
                    }

                    // ─── FIX P0: Decrement connectedCount for the session ──────
                    // gameCount.js reads this Redis counter instead of doing a
                    // MongoDB countDocuments query on every countdown trigger.
                    if (gameSessionId && gameSessionId !== "NO_SESSION_ID") {
                        await redis.decr(`connectedCount:${gameSessionId}`);
                        console.log(`[COUNTER] Decremented connectedCount for session ${gameSessionId}`);
                    }
                    // ─────────────────────────────────────────────────────────────

                    await Promise.all([
                        redis.hDel("userSelections",     socket.id),
                        redis.hDel("joinGameSocketsInfo", socket.id),
                        redis.del(graceKey),
                    ]);

                } catch (err) {
                    console.error(`[CLEANUP ERROR] ${telegramId}:`, err);
                }
            }, cleanupDelay);

        } catch (err) {
            console.error(`[DISCONNECT CRITICAL] ${socket.id}:`, err);
        }
    });
};
