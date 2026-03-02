const User = require("../models/user");
const GameCard = require("../models/GameCard");
const PlayerSession = require("../models/PlayerSession");
const { getGameRoomsKey } = require("../utils/redisKeys");
const { checkAndResetIfEmpty } = require("../utils/checkandreset");

// 🔥 NEW IMPORTS
const { queueUserUpdate } = require("../utils/emitBatcher");
const { dbQueue, defaultJobOptions } = require("../utils/dbQueue");

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

            // 🔥🔥🔥 RELEASE ALL PLAYER CARDS + BATCHER + DB QUEUE 🔥🔥🔥
            const gameCardsKey = `gameCards:${strGameId}`;
            const takenCardsKey = `takenCards:${strGameId}`;
            const userHeldCardsKey = `userHeldCards:${strGameId}:${strTelegramId}`;
            const strTg = String(telegramId).trim();

            // Step 1: Fetch cards before release
            const cardsToRelease = await redis.lRange(userHeldCardsKey, 0, -1);

            if (cardsToRelease.length > 0) {
                console.log(`🧹 Releasing ${cardsToRelease.length} cards for ${strTg}: ${cardsToRelease.join(', ')}`);

                // Redis atomic release (your existing excellent logic)
                const multi = redis.multi();
                multi.hDel(gameCardsKey, ...cardsToRelease);
                multi.sRem(takenCardsKey, ...cardsToRelease);
                multi.del(userHeldCardsKey);
                await multi.exec();

                // Double-check leftovers (you already had this — keeping it)
                const verifyGameCards = await redis.hGetAll(gameCardsKey);
                const leftovers = Object.entries(verifyGameCards)
                    .filter(([_, ownerId]) => String(ownerId).trim() === strTg)
                    .map(([cardId]) => cardId);

                if (leftovers.length > 0) {
                    console.log(`⚠️ Found leftovers, cleaning: ${leftovers.join(', ')}`);
                    await redis.hDel(gameCardsKey, ...leftovers);
                }

                const finalReleased = [...cardsToRelease, ...leftovers];

                // 🔥 THIS IS THE KEY LINE (replaces old emit)
                queueUserUpdate(strGameId, strTg, [], finalReleased, io);
                console.log(`✅ Queued batched release of ${finalReleased.length} cards via emitBatcher`);

                // 🔥 Queue DB update via your worker (consistent with everywhere else)
                await dbQueue.add('db-write', {
                    type: 'RELEASE_CARDS',
                    payload: { gameId: strGameId, cardIds: finalReleased }
                }, { ...defaultJobOptions, priority: 2 });

                console.log(`📤 Queued RELEASE_CARDS job to dbWorker`);
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