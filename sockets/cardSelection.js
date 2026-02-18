const GameCard  = require("../models/GameCard");

const SELECT_CARDS_LUA = `
local userHeldKey = KEYS[1]
local takenKey = KEYS[2]
local gameCardsKey = KEYS[3]

local telegramId = ARGV[1]
local newCardsCSV = ARGV[2]

-- Parse incoming cards
local newSet = {}
for id in string.gmatch(newCardsCSV, '([^,]+)') do
    newSet[id] = true
end

-- Current user cards
local oldCards = redis.call("SMEMBERS", userHeldKey)
local oldSet = {}
for _, id in ipairs(oldCards) do oldSet[id] = true end

local toAdd = {}
local toRelease = {}

-- Find additions
for id, _ in pairs(newSet) do
    if not oldSet[id] then table.insert(toAdd, id) end
end

-- Find releases
for id, _ in pairs(oldSet) do
    if not newSet[id] then table.insert(toRelease, id) end
end

-- Try claim new cards
for _, id in ipairs(toAdd) do
    if redis.call("SADD", takenKey, id) == 0 then
        for _, c in ipairs(toAdd) do redis.call("SREM", takenKey, c) end
        return {err="CARD_TAKEN", id}
    end
end

-- Apply releases
for _, id in ipairs(toRelease) do
    redis.call("SREM", takenKey, id)
    redis.call("SREM", userHeldKey, id)
    redis.call("HDEL", gameCardsKey, id)
end

-- Apply additions
for _, id in ipairs(toAdd) do
    redis.call("SADD", userHeldKey, id)
    redis.call("HSET", gameCardsKey, id, telegramId)
end

return {
    "OK",
    table.concat(toAdd, ","),
    table.concat(toRelease, ",")
}
`;


const RELEASE_ONE_LUA = `
local takenKey = KEYS[1]
local userHeldKey = KEYS[2]
local gameCardsKey = KEYS[3]

local cardId = ARGV[1]
local telegramId = ARGV[2]

local owner = redis.call("HGET", gameCardsKey, cardId)
if owner ~= telegramId then
    return {err="NOT_OWNER"}
end

redis.call("SREM", takenKey, cardId)
redis.call("SREM", userHeldKey, cardId)
redis.call("HDEL", gameCardsKey, cardId)

return "OK"
`;


const RELEASE_ALL_LUA = `
local takenKey = KEYS[1]
local userHeldKey = KEYS[2]
local gameCardsKey = KEYS[3]

local cards = redis.call("SMEMBERS", userHeldKey)

if #cards > 0 then
    redis.call("SREM", takenKey, unpack(cards))
    redis.call("HDEL", gameCardsKey, unpack(cards))
    redis.call("DEL", userHeldKey)
end

return cards
`;


module.exports = function cardSelectionHandler(socket, io, redis, saveToDb) {
socket.on("cardSelected", async (data) => {
    const { telegramId, gameId, cardIds, cardsData, requestId } = data;

    const strTelegramId = String(telegramId);
    const strGameId = String(gameId);

    const lockKey = `lock:userAction:${strGameId}:${strTelegramId}`;
    const userHeldCardsKey = `userHeldCards:${strGameId}:${strTelegramId}`;  // ✅ THIS
    const takenCardsKey = `takenCards:${strGameId}`;
    const gameCardsKey = `gameCards:${strGameId}`;
   

    const hasLock = await redis.set(lockKey, requestId, { NX: true, EX: 2 });
    if (!hasLock) {
        return socket.emit("cardError", { message: "Processing...", requestId });
    }

    try {
        const result = await redis.eval(SELECT_CARDS_LUA, {
            keys: [
                `userHeldCards:${strGameId}:${strTelegramId}`,
                `takenCards:${strGameId}`,
                `gameCards:${strGameId}`
            ],
            arguments: [strTelegramId, cardIds.map(String).join(",")]
        });

        if (!result || result[0] !== "OK") {
            throw new Error("Card selection failed");
        }

        console.log("Lua raw result:", result);

        const added = result[1]
            ? result[1].split(",").filter(Boolean)
            : [];

        console.log("Parsed added:", added);

        const released = result[2]
            ? result[2].split(",").filter(Boolean)
            : [];

        console.log("ADDED:", added);   // 👈 debug
        console.log("RELEASED:", released);

        const myCurrentCards = await redis.sMembers(userHeldCardsKey);

        socket.emit("cardConfirmed", {
            requestId,
            currentHeldCardIds: myCurrentCards.map(Number)  // <-- ALL owned cards
        });

        io.to(strGameId).emit("cardsUpdated", {
            ownerId: strTelegramId,
            selected: added,
            released
        });

        // 🔥 BACKGROUND DB WRITES
        saveToDatabase(strGameId, strTelegramId, added, cardsData).catch(console.error);
        releaseCardsInDb(strGameId, released).catch(console.error);
        //releaseCardsInDb(strGameId, released).catch(console.error);

    } catch (err) {
        socket.emit("cardError", { message: err.message, requestId });
    } finally {
        await redis.del(lockKey);
    }
});



socket.on("cardDeselected", async ({ telegramId, cardId, gameId }) => {
    const result = await redis.eval(RELEASE_ONE_LUA, {
        keys: [
            `takenCards:${gameId}`,
            `userHeldCards:${gameId}:${telegramId}`,
            `gameCards:${gameId}`
        ],
        arguments: [String(cardId), String(telegramId)]
    });

    if (result === "OK") {
        socket.to(gameId).emit("cardReleased", { cardId, telegramId });
    }
});


socket.on("unselectCardOnLeave", async ({ gameId, telegramId }) => {
    const released = await redis.eval(RELEASE_ALL_LUA, {
        keys: [
            `takenCards:${gameId}`,
            `userHeldCards:${gameId}:${telegramId}`,
            `gameCards:${gameId}`
        ]
    });

    if (released.length > 0) {
        io.to(gameId).emit("cardsReleased", { cardIds: released, telegramId });
    }
});

// Helper for background writes
    async function saveToDatabase(gameId, telegramId, cardIds, cardsData) {
        console.log("saveToDb called with:", cardIds);
        const dbUpdatePromises = cardIds.map(cardId => {
            const cardGrid = cardsData[cardId];
            if (!cardGrid) return Promise.resolve();
            const cleanCard = cardGrid.map(row => row.map(c => (c === "FREE" ? 0 : Number(c))));
            
            return GameCard.updateOne(
                { gameId, cardId: Number(cardId) },
                { $set: { card: cleanCard, isTaken: true, takenBy: telegramId } },
                { upsert: true }
            );
        });
        await Promise.all(dbUpdatePromises);
    }

    async function releaseCardsInDb(gameId, releasedCardIds) {
    if (!releasedCardIds || releasedCardIds.length === 0) return;

    try {
        const numericIds = releasedCardIds.map(id => Number(id));

        const result = await GameCard.updateMany(
            {
                gameId: String(gameId),
                cardId: { $in: numericIds }
            },
            {
                $set: {
                    isTaken: false,
                    takenBy: null
                }
            }
        );

        console.log(`✅ Released ${result.modifiedCount} cards in DB`);
    } catch (err) {
        console.error("❌ DB release failed:", err);
        throw err;
    }
}


}