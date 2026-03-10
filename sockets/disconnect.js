const { safeJsonParse }    = require("../utils/safeJsonParse");
// pendingDisconnectTimeouts (in-memory) intentionally NOT imported — grace period
// is handled entirely through Redis keys (graceKey with EX TTL), which is
// correct and process-safe.  The in-memory map is no longer needed.

const { queueUserUpdate }  = require("../utils/emitBatcher");
const { dbQueue, defaultJobOptions } = require("../utils/dbQueue");
const { updateCardSnapshot } = require("../utils/updateCardSnapshot");

// ─── FIX P1: Also HDELs gameCardsKey so ownership map stays clean ─────────────
const RELEASE_ALL_LUA = `
local takenKey    = KEYS[1]
local userHeldKey = KEYS[2]
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
                .hGet("userSelections",    socket.id)
                .hGet("joinGameSocketsInfo", socket.id)
                .exec();

            let userPayload = null;
            let phase       = null;
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

            // ── Grace period: 2 s Redis TTL ──────────────────────────────────
            const graceKey     = `pendingDisconnect:${telegramId}:${gameId}:${phase || "unknown"}`;
            const graceSeconds = 2;

            await redis.set(graceKey, "1", "EX", graceSeconds);
            console.log(`[GRACE] Set ${graceKey} → ${graceSeconds}s TTL`);

            const cleanupDelay = graceSeconds * 1000 + 600; // 600 ms accuracy buffer

            setTimeout(async () => {
                try {
                    console.log(`[TIMEOUT FIRED] Cleanup for ${telegramId} after ${cleanupDelay}ms`);

                    const graceStillActive = await redis.get(graceKey);
                    if (!graceStillActive) {
                        console.log(`[GRACE CANCELLED] ${telegramId} reconnected → skipping cleanup`);
                        return;
                    }

                    console.log(`[GRACE EXPIRED] Processing disconnect cleanup for ${telegramId}`);

                    // ─── FIX P0: SINGLE release path ─────────────────────────
                    // Previously the code BOTH pushed to disconnect-cleanup-queue
                    // AND ran the Lua release inline, releasing cards TWICE and
                    // corrupting game state.
                    //
                    // Decision: inline Lua release is the authoritative path.
                    // The raw Redis list queue (disconnect-cleanup-queue) is
                    // REMOVED.  If you need a background worker for heavy cleanup
                    // (e.g. MongoDB PlayerSession update), add a BullMQ job AFTER
                    // the Lua release — NOT a second card release.
                    // ─────────────────────────────────────────────────────────

                    const released = await redis.eval(RELEASE_ALL_LUA, {
                        keys: [
                            `takenCards:${gameId}`,
                            `userHeldCards:${gameId}:${telegramId}`,
                            `gameCards:${gameId}`,
                        ],
                    });

                    console.log(`[RELEASE RESULT] ${telegramId} → ${JSON.stringify(released)}`);

                    if (Array.isArray(released) && released.length > 0) {
                        // Instant UI update for all room members
                        queueUserUpdate(gameId, telegramId, [], released, io);
                        console.log(`[BATCH] Queued UI release for ${released.length} cards`);

                        // Async DB write via BullMQ (single queue, no duplicate)
                        await dbQueue.add(
                            "db-write",
                            { type: "RELEASE_CARDS", payload: { gameId, cardIds: released } },
                            { ...defaultJobOptions, priority: 2 }
                        );

                        // Update snapshot so new joiners see correct state
                        await updateCardSnapshot(gameId, redis);
                        console.log(`[SNAPSHOT] Updated after release for game ${gameId}`);
                    } else {
                        console.log(`[NO CARDS TO RELEASE] for ${telegramId}`);
                    }

                    // Tidy up session tracking hashes
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
