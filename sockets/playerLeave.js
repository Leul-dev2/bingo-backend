// playerLeave.js  ← FULLY FIXED VERSION (atomic release, no more "only 1 card" bug)

const User = require("../models/user");
const GameCard = require("../models/GameCard");
const PlayerSession = require("../models/PlayerSession");
const { getGameRoomsKey } = require("../utils/redisKeys");
const { checkAndResetIfEmpty } = require("../utils/checkandreset");

// 🔥 NEW IMPORTS (keep your existing batcher + queue)
const { queueUserUpdate } = require("../utils/emitBatcher");
const { dbQueue, defaultJobOptions } = require("../utils/dbQueue");
const { updateCardSnapshot } = require("../utils/updateCardSnapshot");

// 🔥 RELEASE_ALL_LUA (copied from cardSelection.js so playerLeave is self-contained)
//    This is the exact same atomic script used everywhere else.
//    (Recommended: move to utils/luaScripts.js later to avoid duplication)
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

module.exports = function playerLeaveHandler(socket, io, redis, state) {
    socket.on("playerLeave", async ({ gameId, GameSessionId, telegramId }, callback) => {
        const strTelegramId = String(telegramId);
        const strGameId = String(gameId);
        console.log(`🚪 Player ${telegramId} is leaving game ${gameId} ${GameSessionId}`);

        try {
            // --- Release the player's balance reservation lock ---
            const userUpdateResult = await User.updateOne(
                { telegramId: strTelegramId, reservedForGameId: strGameId },
                { $unset: { reservedForGameId: "" } }
            );

            if (userUpdateResult.modifiedCount > 0) {
                console.log(`✅ Balance reservation lock for player ${telegramId} released.`);
            }

            await PlayerSession.updateOne(
                { GameSessionId, telegramId: strTelegramId },
                { $set: { status: 'disconnected' } }
            );
            console.log(`✅ PlayerSession record for ${strTelegramId} updated to disconnected.`);

            // --- Remove from Redis sets ---
            await Promise.all([
                redis.sRem(`gameSessions:${gameId}`, strTelegramId),
                redis.sRem(`gameRooms:${gameId}`, strTelegramId),
            ]);

            // 🔥🔥🔥 ATOMIC RELEASE ALL PLAYER CARDS (FIXED) 🔥🔥🔥
            const takenCardsKey = `takenCards:${strGameId}`;
            const userHeldCardsKey = `userHeldCards:${strGameId}:${strTelegramId}`;
            const gameCardsKey = `gameCards:${strGameId}`;

            const released = await redis.eval(RELEASE_ALL_LUA, {
                keys: [takenCardsKey, userHeldCardsKey, gameCardsKey]
            });

            if (Array.isArray(released) && released.length > 0) {
                console.log(`🧹 Released ${released.length} cards atomically for ${strTelegramId}:`, released);

                // 🔥 Instant UI update for everyone (batcher)
                queueUserUpdate(strGameId, strTelegramId, [], released, io);
                console.log(`✅ Queued batched release of ${released.length} cards via emitBatcher`);

                await updateCardSnapshot(strGameId, redis);
                console.log(`[SNAPSHOT] Updated after playerLeave by ${strTelegramId}`);

                // 🔥 Queue DB update (consistent with cardSelection & unselectCardOnLeave)
                await dbQueue.add('db-write', {
                    type: 'RELEASE_CARDS',
                    payload: { gameId: strGameId, cardIds: released }
                }, { ...defaultJobOptions, priority: 2 });

                console.log(`📤 Queued RELEASE_CARDS job to dbWorker`);
            } else {
                console.log(`[playerLeave] ${strTelegramId} had no cards to release`);
            }

            // --- Cleanup remaining keys ---
            await Promise.all([
                redis.hDel("userSelections", socket.id),
                redis.hDel("userSelections", strTelegramId),
                redis.hDel("userSelectionsByTelegramId", strTelegramId),
                redis.sRem(getGameRoomsKey(gameId), strTelegramId),
                redis.del(`activeSocket:${strTelegramId}:${socket.id}`),
                redis.del(`countdown:${strGameId}`),
            ]);

            // Emit updated player count
            const playerCount = await redis.sCard(`gameRooms:${gameId}`) || 0;
            io.to(gameId).emit("playerCountUpdate", { gameId, playerCount });

            await checkAndResetIfEmpty(gameId, GameSessionId, telegramId, socket, io, redis, state);

            if (callback) callback();
        } catch (error) {
            console.error("❌ Error handling playerLeave:", error);
            if (callback) callback();
        }
    });
};