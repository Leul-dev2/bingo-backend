const GameCard = require("../models/GameCard");

// --- LUA SCRIPTS ---
const CLAIM_LUA = `
    local takenCardsKey = KEYS[1]
    local userHeldCardsKey = KEYS[2]
    local gameCardsKey = KEYS[3]
    local cardId = ARGV[1]
    local telegramId = ARGV[2]
    local maxCards = tonumber(ARGV[3])

    if redis.call('SISMEMBER', takenCardsKey, cardId) == 1 then
        return {err = "CARD_TAKEN"}
    end

    local currentCount = redis.call('SCARD', userHeldCardsKey)
    if currentCount >= maxCards then
        return {err = "LIMIT_EXCEEDED"}
    end

    redis.call('SADD', takenCardsKey, cardId)
    redis.call('SADD', userHeldCardsKey, cardId)
    redis.call('HSET', gameCardsKey, cardId, telegramId)
    return "OK"
`;

const RELEASE_ALL_LUA = `
    local takenCardsKey = KEYS[1]
    local userHeldCardsKey = KEYS[2]
    local gameCardsKey = KEYS[3]
    
    local cards = redis.call('SMEMBERS', userHeldCardsKey)
    if #cards > 0 then
        redis.call('SREM', takenCardsKey, unpack(cards))
        redis.call('HDEL', gameCardsKey, unpack(cards))
        redis.call('DEL', userHeldCardsKey)
    end
    return cards
`;

module.exports = function CardSelectionHandler(socket, io, redis) {

    /**
     * 1. CARD SELECTED (Claiming a card)
     */
    socket.on("cardSelected", async (data) => {
        const { telegramId, gameId, cardIds, cardsData, requestId } = data;
        const strTelegramId = String(telegramId);
        const strGameId = String(gameId);
        const MAX_CARDS = 3;

        const selectionKeys = [
            `takenCards:${strGameId}`, 
            `userHeldCards:${strGameId}:${strTelegramId}`, 
            `gameCards:${strGameId}`
        ];
        const userLockKey = `lock:userAction:${strGameId}:${strTelegramId}`;

        const hasLock = await redis.set(userLockKey, requestId, "NX", "EX", 2);
        if (!hasLock) return socket.emit("cardError", { message: "Processing...", requestId });

        try {
            const currentHeld = await redis.sMembers(selectionKeys[1]);
            const currentHeldSet = new Set(currentHeld.map(String));
            const cardIdToClaim = cardIds.find(id => !currentHeldSet.has(String(id)));

            if (cardIdToClaim !== undefined) {
                const result = await redis.eval(CLAIM_LUA, {
                    keys: selectionKeys,
                    arguments: [String(cardIdToClaim), strTelegramId, String(MAX_CARDS)]
                });

                if (result && typeof result === 'object' && result.err) {
                    if (result.err === "CARD_TAKEN") throw new Error("Card already taken!");
                    if (result.err === "LIMIT_EXCEEDED") throw new Error(`Limit reached.`);
                }
            }

            socket.emit("cardConfirmed", { cardIds, requestId });
            io.to(strGameId).emit("cardsUpdated", { ownerId: strTelegramId, selected: cardIds });

            // Background Write
            saveToDb(strGameId, strTelegramId, cardIds, cardsData).catch(console.error);

        } catch (err) {
            socket.emit("cardError", { message: err.message, requestId });
        } finally {
            await redis.del(userLockKey);
        }
    });

    /**
     * 2. CARD DESELECTED (Releasing one specific card)
     */
    socket.on("cardDeselected", async ({ telegramId, cardId, gameId }) => {
        const strTelegramId = String(telegramId);
        const strCardId = String(cardId);
        const strGameId = String(gameId);

        const takenCardsKey = `takenCards:${strGameId}`;
        const userHeldCardsKey = `userHeldCards:${strGameId}:${strTelegramId}`;
        const gameCardsKey = `gameCards:${strGameId}`;

        try {
            // Verify ownership first
            const owner = await redis.hGet(gameCardsKey, strCardId);
            if (owner !== strTelegramId) return;

            // Atomic Release in Redis
            const multi = redis.multi();
            multi.sRem(takenCardsKey, strCardId);
            multi.sRem(userHeldCardsKey, strCardId);
            multi.hDel(gameCardsKey, strCardId);
            await multi.exec();

            // Background DB Release
            GameCard.updateOne(
                { gameId: strGameId, cardId: Number(strCardId) },
                { $set: { isTaken: false, takenBy: null } }
            ).catch(console.error);

            socket.to(strGameId).emit("cardReleased", { cardId: strCardId, telegramId: strTelegramId });

        } catch (err) {
            console.error("Deselection error:", err);
        }
    });

    /**
     * 3. UNSELECT ON LEAVE (Mass release)
     */
    socket.on("unselectCardOnLeave", async ({ gameId, telegramId }) => {
        const strGameId = String(gameId);
        const strTelegramId = String(telegramId).trim();
        const leaveKeys = [
            `takenCards:${strGameId}`, 
            `userHeldCards:${strGameId}:${strTelegramId}`, 
            `gameCards:${strGameId}`
        ];

        try {
            // Atomic Release via Lua (Returns array of released card IDs)
            const releasedCards = await redis.eval(RELEASE_ALL_LUA, {
                keys: leaveKeys,
                arguments: []
            });

            if (releasedCards && releasedCards.length > 0) {
                io.to(strGameId).emit("cardsReleased", { cardIds: releasedCards, telegramId: strTelegramId });
                
                // Background DB Mass Cleanup
                GameCard.updateMany(
                    { gameId: strGameId, cardId: { $in: releasedCards.map(Number) } },
                    { $set: { isTaken: false, takenBy: null } }
                ).catch(err => console.error("Leave DB Cleanup Failed:", err));
            }

            // Cleanup Player Session Data
            await Promise.all([
                redis.hDel("userSelections", socket.id),
                redis.hDel("userSelectionsByTelegramId", strTelegramId),
                redis.sRem(`gameSessions:${strGameId}`, strTelegramId), 
                redis.sRem(`gameRooms:${strGameId}`, strTelegramId) 
            ]);

            const playerCount = await redis.sCard(`gameRooms:${strGameId}`);
            io.to(strGameId).emit("playerCountUpdate", { gameId: strGameId, playerCount });

        } catch (err) {
            console.error("Critical Leave Error:", err);
        }
    });

    // Background Helper
    async function saveToDb(gameId, telegramId, cardIds, cardsData) {
        if (!cardIds || cardIds.length === 0) return;
        const ops = cardIds.map(id => {
            const strId = String(id);
            const grid = cardsData[strId];
            if (!grid) return null;
            const clean = grid.map(r => r.map(c => (c === "FREE" ? 0 : Number(c))));
            return {
                updateOne: {
                    filter: { gameId: String(gameId), cardId: Number(strId) },
                    update: { $set: { card: clean, isTaken: true, takenBy: String(telegramId) } },
                    upsert: true
                }
            };
        }).filter(Boolean);
        if (ops.length > 0) await GameCard.bulkWrite(ops);
    }
};