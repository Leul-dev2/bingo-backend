const GameCard = require("../models/GameCard");

// --- LUA SCRIPTS FOR ATOMICITY ---

// Script for selecting/claiming a card
const CLAIM_SCRIPT = `
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

// Script for releasing all cards on leave (Clean cleanup)
const RELEASE_ALL_SCRIPT = `
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
    
    // Pre-load scripts
    let claimSha, releaseAllSha;
    const loadScripts = async () => {
        claimSha = await redis.script("LOAD", CLAIM_SCRIPT);
        releaseAllSha = await redis.script("LOAD", RELEASE_ALL_SCRIPT);
    };
    loadScripts().catch(console.error);

    /**
     * SELECT CARD LOGIC
     */
    socket.on("cardSelected", async (data) => {
        const { telegramId, gameId, cardIds, cardsData, requestId } = data;
        const strTelegramId = String(telegramId);
        const strGameId = String(gameId);
        const MAX_CARDS = 3;

        const userLockKey = `lock:userAction:${strGameId}:${strTelegramId}`;
        const takenCardsKey = `takenCards:${strGameId}`;
        const userHeldCardsKey = `userHeldCards:${strGameId}:${strTelegramId}`;
        const gameCardsKey = `gameCards:${strGameId}`;

        const hasLock = await redis.set(userLockKey, requestId, "NX", "EX", 2);
        if (!hasLock) return socket.emit("cardError", { message: "Processing...", requestId });

        try {
            const currentHeld = await redis.sMembers(userHeldCardsKey);
            const cardIdToClaim = cardIds.find(id => !currentHeld.includes(String(id)));

            if (cardIdToClaim) {
                const result = await redis.evalsha(claimSha, 3, takenCardsKey, userHeldCardsKey, gameCardsKey, cardIdToClaim, strTelegramId, MAX_CARDS);
                if (result.err === "CARD_TAKEN") throw new Error("Card already taken!");
                if (result.err === "LIMIT_EXCEEDED") throw new Error(`Limit of ${MAX_CARDS} reached.`);
            }

            socket.emit("cardConfirmed", { cardIds, requestId });
            io.to(strGameId).emit("cardsUpdated", { ownerId: strTelegramId, selected: cardIds });

            // Background Persistence
            saveToDb(strGameId, strTelegramId, cardIds, cardsData).catch(console.error);

        } catch (err) {
            socket.emit("cardError", { message: err.message, requestId });
        } finally {
            await redis.del(userLockKey);
        }
    });

    /**
     * UNSELECT ON LEAVE (Clean and Fast)
     */
    socket.on("unselectCardOnLeave", async ({ gameId, telegramId }) => {
        const strGameId = String(gameId);
        const strTelegramId = String(telegramId).trim();
        
        const takenCardsKey = `takenCards:${strGameId}`;
        const userHeldCardsKey = `userHeldCards:${strGameId}:${strTelegramId}`;
        const gameCardsKey = `gameCards:${strGameId}`;

        try {
            // 1. ATOMIC RELEASE IN REDIS
            // The Lua script finds all cards the user held, removes them from global 'taken'
            // and the game assignment map, then deletes the user's specific set.
            const releasedCards = await redis.evalsha(releaseAllSha, 3, takenCardsKey, userHeldCardsKey, gameCardsKey);

            if (releasedCards && releasedCards.length > 0) {
                // 2. IMMEDIATE BROADCAST
                io.to(strGameId).emit("cardsReleased", { 
                    cardIds: releasedCards, 
                    telegramId: strTelegramId 
                });

                // 3. BACKGROUND MONGODB CLEANUP
                GameCard.updateMany(
                    { gameId: strGameId, cardId: { $in: releasedCards.map(Number) } },
                    { $set: { isTaken: false, takenBy: null } }
                ).catch(err => console.error("Leave DB Cleanup Failed:", err));
            }

            // 4. CLEANUP SESSION METADATA
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

    // Helper: Background DB Update
    async function saveToDb(gameId, telegramId, cardIds, cardsData) {
        const ops = cardIds.map(id => {
            const grid = cardsData[id];
            if (!grid) return null;
            const clean = grid.map(r => r.map(c => (c === "FREE" ? 0 : Number(c))));
            return {
                updateOne: {
                    filter: { gameId, cardId: Number(id) },
                    update: { $set: { card: clean, isTaken: true, takenBy: telegramId } },
                    upsert: true
                }
            };
        }).filter(Boolean);
        
        if (ops.length > 0) await GameCard.bulkWrite(ops);
    }
};