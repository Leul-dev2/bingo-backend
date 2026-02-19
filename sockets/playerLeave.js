const User = require("../models/user");
const GameCard = require("../models/GameCard");
const PlayerSession = require("../models/PlayerSession");
const { getGameRoomsKey } = require("../utils/redisKeys");
const { checkAndResetIfEmpty } = require("../utils/checkandreset");
 
 
 module.exports = function playerLeaveHandler(socket, io, redis, state) { 
 // ✅ Handle playerLeave event
    socket.on("playerLeave", async ({ gameId, GameSessionId, telegramId }, callback) => {
        const strTelegramId = String(telegramId);
        const strGameId = String(gameId);
        console.log(`🚪 Player ${telegramId} is leaving game ${gameId} ${GameSessionId}`);

        try {
            // --- Release the player's balance reservation lock in the database ---
            const userUpdateResult = await User.updateOne(
                { telegramId: strTelegramId, reservedForGameId: strGameId },
                { $unset: { reservedForGameId: "" } }
            );

            if (userUpdateResult.modifiedCount > 0) {
                console.log(`✅ Balance reservation lock for player ${telegramId} released.`);
            } else {
                console.log(`⚠️ No balance reservation lock found for player ${telegramId}.`);
            }

        await PlayerSession.updateOne(
            {
                GameSessionId: GameSessionId,
                telegramId: strTelegramId,
            },
            {
                $set: { status: 'disconnected' }
            }
        );

        console.log(`✅ PlayerSession record for ${strTelegramId} updated to disconnected status.`);


            // --- Remove from Redis sets and hashes ---
            await Promise.all([
                redis.sRem(`gameSessions:${gameId}`, strTelegramId),
                redis.sRem(`gameRooms:${gameId}`, strTelegramId),
            ]);


                // --- RELEASE ALL PLAYER CARDS ---
        const gameCardsKey = `gameCards:${strGameId}`;
        const takenCardsKey = `takenCards:${strGameId}`; // 🆕 The Global Set
        const userHeldCardsKey = `userHeldCards:${strGameId}:${strTelegramId}`;
        const strTg = String(telegramId).trim();

        // Step 1: Fetch cards before release
        const cardsToRelease = await redis.lRange(userHeldCardsKey, 0, -1)

            // Step 3: Release all those cards
            if (cardsToRelease.length > 0) {
                console.log(`🧹 Releasing ${cardsToRelease.length} cards for ${strTg}: ${cardsToRelease.join(', ')}`);

            const multi = redis.multi();
            multi.hDel(gameCardsKey, ...cardsToRelease);     // Remove Owner mapping
            multi.sRem(takenCardsKey, ...cardsToRelease);    // Make available for others
            multi.del(userHeldCardsKey);                     // Delete the user's pocket
            await multi.exec();

                await GameCard.updateMany(
                    { gameId: strGameId, cardId: { $in: cardsToRelease.map(Number) } },
                    { $set: { isTaken: false, takenBy: null } }
                );

                // Step 4: Double-check Redis (handle race condition)
                const verifyGameCards = await redis.hGetAll(gameCardsKey);
                const leftovers = Object.entries(verifyGameCards)
                    .filter(([_, ownerId]) => String(ownerId).trim() == strTg)
                    .map(([cardId]) => cardId);

                if (leftovers.length > 0) {
                    console.log(`⚠️ Found leftover cards after release, deleting again: ${leftovers.join(', ')}`);
                    await redis.hDel(gameCardsKey, ...leftovers);
                }

                io.to(gameId).emit("cardsReleased", {
                    cardIds: [...cardsToRelease, ...leftovers],
                    telegramId: strTg,
                });
            }


            // --- Remove userSelections entries by both socket.id and telegramId after usage ---
            await Promise.all([
                redis.hDel("userSelections", socket.id),
                redis.hDel("userSelections", strTelegramId), // Legacy
                redis.hDel("userSelectionsByTelegramId", strTelegramId), // Legacy
                redis.sRem(getGameRoomsKey(gameId), strTelegramId),
                // deleteCardsByTelegramId(strGameId, strTelegramId, redis), // This is redundant now
                redis.del(`activeSocket:${strTelegramId}:${socket.id}`),
                redis.del(`countdown:${strGameId}`),
            ]);

            // Emit updated player count
            const playerCount = await redis.sCard(`gameRooms:${gameId}`) || 0;
            io.to(gameId).emit("playerCountUpdate", { gameId, playerCount });
            await checkAndResetIfEmpty(gameId, GameSessionId, telegramId,  socket, io, redis, state);

            if (callback) callback();
        } catch (error) {
            console.error("❌ Error handling playerLeave:", error);
            if (callback) callback();
        }
    });
}