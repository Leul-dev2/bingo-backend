const GameCard = require("../models/GameCard");

const SELECT_CARDS_LUA = `
local userHeldKey = KEYS[1]
local takenKey = KEYS[2]
local gameCardsKey = KEYS[3]

local telegramId = ARGV[1]
local newCardsCSV = ARGV[2]
local maxAllowed = tonumber(ARGV[3]) or 2  -- Fallback

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

-- Sort toAdd for deterministic order
table.sort(toAdd, function(a,b) return tonumber(a) < tonumber(b) end)

-- 🔥 LIMIT CHECK
local finalCount = (#oldCards - #toRelease) + #toAdd
if finalCount > maxAllowed then
    return {"LIMIT_REACHED", tostring(maxAllowed)}
end

-- Try claim new cards
local successfullyAdded = {}
for _, id in ipairs(toAdd) do
    if redis.call("SADD", takenKey, id) == 1 then
        table.insert(successfullyAdded, id)
    else
        -- Only rollback the ones we JUST added
        for _, c in ipairs(successfullyAdded) do 
            redis.call("SREM", takenKey, c) 
        end
        return {"CARD_TAKEN", id}
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


module.exports = function cardSelectionHandler(socket, io, redis, saveToDb) {
  socket.on("cardSelected", async (data) => {
    const { telegramId, gameId, cardIds, cardsData, requestId } = data;
    const strTelegramId = String(telegramId);
    const strGameId = String(gameId);

    const lockKey = `lock:userAction:${strGameId}:${strTelegramId}`;
    const userHeldCardsKey = `userHeldCards:${strGameId}:${strTelegramId}`;
    const takenCardsKey = `takenCards:${strGameId}`;
    const gameCardsKey = `gameCards:${strGameId}`;

    const hasLock = await redis.set(lockKey, requestId, { NX: true, EX: 2 });
    if (!hasLock) {
      return socket.emit("cardError", { message: "Processing...", requestId });
    }

    try {
      const MAX_CARDS = 2;
      const result = await redis.eval(SELECT_CARDS_LUA, {
        keys: [userHeldCardsKey, takenCardsKey, gameCardsKey],
        arguments: [strTelegramId, cardIds.map(String).join(","), String(MAX_CARDS)]
      });

      // Specific error checks first
      if (result[0] === "LIMIT_REACHED") {
        const current = await redis.sMembers(userHeldCardsKey);
        return socket.emit("cardError", {
          message: `You can hold max ${result[1]} cards`,
          requestId,
          currentHeldCardIds: current.map(Number)
        });
      }

      if (result[0] === "CARD_TAKEN") {
        throw new Error(`CARD_TAKEN:${result[1]}`);
      }

      // General failure
      if (!result || result[0] !== "OK") {
        throw new Error("Card selection failed");
      }

      const added = result[1] ? result[1].split(",").filter(Boolean) : [];
      const released = result[2] ? result[2].split(",").filter(Boolean) : [];

      console.log("ADDED:", added);
      console.log("RELEASED:", released);

      const myCurrentCards = await redis.sMembers(userHeldCardsKey);

      socket.emit("cardConfirmed", {
        requestId,
        currentHeldCardIds: myCurrentCards.map(Number)  // Use server truth
      });

      io.to(strGameId).emit("cardsUpdated", {
        ownerId: strTelegramId,
        selected: added,
        released
      });

      // BACKGROUND DB WRITES
      saveToDatabase(strGameId, strTelegramId, added, cardsData).catch(console.error);
      releaseCardsInDb(strGameId, released).catch(console.error);

    } catch (err) {
      const current = await redis.sMembers(userHeldCardsKey);
      socket.emit("cardError", { message: err.message, requestId, currentHeldCardIds: current.map(Number) });
    } finally {
      await redis.del(lockKey);
    }
  });

  socket.on("cardDeselected", async ({ telegramId, cardId, gameId }) => {
    const result = await redis.eval(RELEASE_ONE_LUA, {
      keys: [`takenCards:${gameId}`, `userHeldCards:${gameId}:${telegramId}`, `gameCards:${gameId}`],
      arguments: [String(cardId), String(telegramId)]
    });

    if (result === "OK") {
      socket.to(gameId).emit("cardReleased", { cardId, telegramId });
    }
  });

  socket.on("unselectCardOnLeave", async ({ gameId, telegramId }) => {
    const released = await redis.eval(RELEASE_ALL_LUA, {
      keys: [`takenCards:${gameId}`, `userHeldCards:${gameId}:${telegramId}`, `gameCards:${gameId}`]
    });

    if (released.length > 0) {
      io.to(gameId).emit("cardsReleased", { cardIds: released, telegramId });
    }
  });


// Helper for background writes
   async function saveToDatabase(gameId, telegramId, cardIds, cardsData) {
    const ops = cardIds.map(cardId => {
        const cardGrid = cardsData[cardId];
        const cleanCard = cardGrid.map(row => row.map(c => (c === "FREE" ? 0 : Number(c))));
        return {
            updateOne: {
                filter: { gameId, cardId: Number(cardId) },
                update: { $set: { card: cleanCard, isTaken: true, takenBy: telegramId } },
                upsert: true
            }
        };
    });
    if (ops.length > 0) await GameCard.bulkWrite(ops);
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