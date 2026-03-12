const User          = require("../models/user");
const PlayerSession = require("../models/PlayerSession");
const { getGameRoomsKey }         = require("../utils/redisKeys");
const { checkAndResetIfEmpty }    = require("../utils/checkandreset");
const { queueUserUpdate }         = require("../utils/emitBatcher");
const { dbQueue, defaultJobOptions } = require("../utils/dbQueue");
const { updateCardSnapshot }      = require("../utils/updateCardSnapshot");

// ─── Shared Lua: release all cards atomically ─────────────────────────────────
// Defined once here — see utils/luaScripts.js if you want to share across files.
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

module.exports = function playerLeaveHandler(socket, io, redis, state) {
    socket.on("playerLeave", async ({ gameId, GameSessionId }, callback) => {
        // ─── FIX P0: Use server-verified identity ─────────────────────────────
        const strTelegramId = socket.data.telegramId;
        if (!strTelegramId) {
            console.warn(`🚫 playerLeave rejected: socket ${socket.id} has no verified telegramId`);
            if (callback) callback();
            return;
        }

        const strGameId = String(gameId);
        console.log(`🚪 Player ${strTelegramId} is leaving game ${gameId} ${GameSessionId}`);

        try {
            // Release balance reservation lock
            const userUpdateResult = await User.updateOne(
                { telegramId: strTelegramId, reservedForGameId: strGameId },
                { $unset: { reservedForGameId: "" } }
            );
            if (userUpdateResult.modifiedCount > 0) {
                console.log(`✅ Balance reservation lock for player ${strTelegramId} released.`);
            }

            await PlayerSession.updateOne(
                { GameSessionId, telegramId: strTelegramId },
                { $set: { status: 'disconnected' } }
            );
            console.log(`✅ PlayerSession for ${strTelegramId} updated to disconnected.`);

            // Remove from Redis sets
            await Promise.all([
                redis.sRem(`gameSessions:${gameId}`, strTelegramId),
                redis.sRem(`gameRooms:${gameId}`,    strTelegramId),
            ]);

            // ─── FIX P0: Decrement Redis connectedCount ───────────────────────
            // This counter is read by gameCount.js instead of doing a MongoDB
            // countDocuments query on every countdown trigger.
            await redis.decr(`connectedCount:${GameSessionId}`);
            // ─────────────────────────────────────────────────────────────────

            // Atomic release of all player cards
            const takenCardsKey    = `takenCards:${strGameId}`;
            const userHeldCardsKey = `userHeldCards:${strGameId}:${strTelegramId}`;
            const gameCardsKey     = `gameCards:${strGameId}`;

            const released = await redis.eval(RELEASE_ALL_LUA, {
                keys: [takenCardsKey, userHeldCardsKey, gameCardsKey]
            });

            if (Array.isArray(released) && released.length > 0) {
                console.log(`🧹 Released ${released.length} cards atomically for ${strTelegramId}:`, released);

                queueUserUpdate(strGameId, strTelegramId, [], released, io);
                console.log(`✅ Queued batched release of ${released.length} cards via emitBatcher`);

                await updateCardSnapshot(strGameId, redis);
                console.log(`[SNAPSHOT] Updated after playerLeave by ${strTelegramId}`);

                await dbQueue.add('db-write', {
                    type:    'RELEASE_CARDS',
                    payload: { gameId: strGameId, cardIds: released }
                }, { ...defaultJobOptions, priority: 2 });

                console.log(`📤 Queued RELEASE_CARDS job to dbWorker`);
            } else {
                console.log(`[playerLeave] ${strTelegramId} had no cards to release`);
            }

            // Cleanup remaining keys
            await Promise.all([
                redis.hDel("userSelections",            socket.id),
                redis.hDel("userSelections",            strTelegramId),
                redis.hDel("userSelectionsByTelegramId", strTelegramId),
                redis.sRem(getGameRoomsKey(gameId),     strTelegramId),
                redis.del(`activeSocket:${strTelegramId}:${socket.id}`),
                redis.del(`countdown:${strGameId}`),
            ]);

            // Emit updated player count
            const playerCount = await redis.sCard(`gameRooms:${gameId}`) || 0;
            io.to(gameId).emit("playerCountUpdate", { gameId, playerCount });

            await checkAndResetIfEmpty(gameId, GameSessionId, strTelegramId, socket, io, redis, state);

            if (callback) callback();
        } catch (error) {
            console.error("❌ Error handling playerLeave:", error);
            if (callback) callback();
        }
    });
};
