const GameCard = require("../models/GameCard");
const { checkRateLimit } = require("../utils/rateLimiter");
const { queueUserUpdate, cleanupBatchQueue  } = require("../utils/emitBatcher");
//const bingoCards = require("../assets/bingoCards.json");
const { dbQueue, defaultJobOptions } = require("../utils/dbQueue");

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


const SELECT_CARDS_LUA = `
local userHeldKey = KEYS[1] -- Redis LIST for user's cards (FIFO)
local takenKey = KEYS[2] -- Redis SET for all taken cards
local gameCardsKey = KEYS[3] -- Redis HASH to track ownership

local telegramId = ARGV[1]
local newCardsCSV = ARGV[2]
local maxAllowed = tonumber(ARGV[3]) or 2 -- fallback

-- Parse incoming as set for diff (unordered ok, we'll sort toAdd)
local newSet = {}
for id in string.gmatch(newCardsCSV, '([^,]+)') do
    newSet[id] = true
end

-- Current user cards in order
local oldCards = redis.call("LRANGE", userHeldKey, 0, -1)
local oldSet = {}
for _, id in ipairs(oldCards) do oldSet[id] = true end

local toAdd = {}
local toReleaseSet = {}  -- Use set for unique releases

-- Find additions
for id, _ in pairs(newSet) do
    if not oldSet[id] then table.insert(toAdd, id) end
end

-- Sort toAdd numerically for deterministic claiming
table.sort(toAdd, function(a,b) return tonumber(a) < tonumber(b) end)

-- Find base releases (deselected)
for _, id in ipairs(oldCards) do
    if not newSet[id] then toReleaseSet[id] = true end
end

-- Base final count
local baseReleaseCount = 0
for _ in pairs(toReleaseSet) do baseReleaseCount = baseReleaseCount + 1 end
local finalCount = (#oldCards - baseReleaseCount) + #toAdd

-- FIFO release if over: add oldest STILL HELD (skip already released)
if finalCount > maxAllowed then
    local overflow = finalCount - maxAllowed
    local addedOverflow = 0
    for i = 1, #oldCards do
        local id = oldCards[i]
        if not toReleaseSet[id] then  -- Not already releasing
            toReleaseSet[id] = true
            addedOverflow = addedOverflow + 1
            if addedOverflow >= overflow then break end
        end
    end
    -- If couldn't find enough to release (extreme case), fail
    if addedOverflow < overflow then
        return {"LIMIT_REACHED", tostring(maxAllowed)}
    end
end

-- Try claim new cards
local successfullyAdded = {}
for _, id in ipairs(toAdd) do
    if redis.call("SADD", takenKey, id) == 1 then
        table.insert(successfullyAdded, id)
    else
        -- Rollback
        for _, c in ipairs(successfullyAdded) do
            redis.call("SREM", takenKey, c)
        end
        return {"CARD_TAKEN", id}
    end
end

-- Collect unique toRelease list (order doesn't matter for release)
local toRelease = {}
for id, _ in pairs(toReleaseSet) do table.insert(toRelease, id) end

-- Apply releases
for _, id in ipairs(toRelease) do
    redis.call("SREM", takenKey, id)
    redis.call("LREM", userHeldKey, 0, id) -- Remove first occurrence
    redis.call("HDEL", gameCardsKey, id)
end

-- Apply additions (append to end for FIFO)
for _, id in ipairs(toAdd) do
    redis.call("RPUSH", userHeldKey, id)
    redis.call("HSET", gameCardsKey, id, telegramId)
end

-- Return unique toRelease (sorted for consistency)
table.sort(toRelease, function(a,b) return tonumber(a) < tonumber(b) end)
return {
    "OK",
    table.concat(toAdd, ","),
    table.concat(toRelease, ",")
}
`;



module.exports = function cardSelectionHandler(socket, io, redis, saveToDb) {
  socket.on("cardSelected", async (data) => {
    const { telegramId, gameId, cardIds, requestId } = data;

    const rateKey = `rate:select:${telegramId}:${gameId}`;

    const allowed = await checkRateLimit(redis, rateKey, 10, 5);

    if (!allowed) {
        socket.emit("rateLimit", { message: "Too fast selecting cards" });
        return;
    }

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

      if (result[0] === "LIMIT_REACHED") {
        const current = await redis.lRange(userHeldCardsKey, 0, -1);
        return socket.emit("cardError", {
          message: `You can hold max ${result[1]} cards`,
          requestId,
          currentHeldCardIds: current.map(Number)
        });
      }

      if (result[0] === "CARD_TAKEN") {
        throw new Error(`CARD_TAKEN:${result[1]}`);
      }

      if (!result || result[0] !== "OK") {
        throw new Error("Card selection failed");
      }

      const added = result[1] ? result[1].split(",").filter(Boolean) : [];
      const released = result[2] ? result[2].split(",").filter(Boolean) : [];

      const myCurrentCards = await redis.lRange(userHeldCardsKey, 0, -1);

      socket.emit("cardConfirmed", {
        requestId,
        currentHeldCardIds: myCurrentCards.map(Number)
      });

      // io.to(strGameId).emit("cardsUpdated", {
      //   ownerId: strTelegramId,
      //   selected: added.map(Number),
      //   released: released.map(Number)
      // });

      if (added.length > 0 || released.length > 0) {
        queueUserUpdate(gameId, telegramId, added, released, io);
      }

     // 🔥 THE FIX: Push to Worker Queue instead of awaiting DB
    // Queue DB Writes with Error Wrapping
        try {
          if (added.length > 0) {
            await dbQueue.add('db-write', {
              type: 'SAVE_CARDS',
              payload: { gameId, telegramId, cardIds: added }
            }, { ...defaultJobOptions, priority: 1 }); // Priority: 1 (High)
          }

          if (released.length > 0) {
            await dbQueue.add('db-write', {
              type: 'RELEASE_CARDS',
              payload: { gameId, cardIds: released }
            }, { ...defaultJobOptions, priority: 2 }); // Priority: 2 (Normal)
          }
        } catch (queueErr) {
          console.error("Critical: Failed to add job to BullMQ:", queueErr);
          // Don't emit error to user yet—they've already had their UI updated
        }

    } catch (err) {
      const current = await redis.lRange(userHeldCardsKey, 0, -1);
      socket.emit("cardError", {
        message: err.message,
        requestId,
        currentHeldCardIds: current.map(Number)
      });
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

//  async function saveToDatabase(gameId, telegramId, cardIds) {
//   try {
//     const ops = cardIds.map(cardId => {
//       // 🚀 THE FIX: Find the card layout directly from the imported JSON
//       // Use Number(cardId) to ensure matching regardless of types
//       const cardObj = bingoCards.find(c => Number(c.id) === Number(cardId));
      
//       if (!cardObj) {
//         console.error(`❌ Card ID ${cardId} not found in bingoCards.json`);
//         return null;
//       }

//       console.log(`✅ Found card layout for Card ID ${cardId} in bingoCards.json`);

//       const cardGrid = cardObj.card; // This is the [ [row], [row] ] array from your JSON
      
//       // Transform "FREE" to 0 and ensure numbers are type-safe
//       const cleanCard = cardGrid.map(row => 
//         row.map(c => (c === "FREE" ? 0 : Number(c)))
//       );

//       return {
//         updateOne: {
//           filter: { 
//             gameId: String(gameId), 
//             cardId: Number(cardId) 
//           },
//           update: { 
//             $set: { 
//               card: cleanCard, 
//               isTaken: true, 
//               takenBy: Number(telegramId) 
//             } 
//           },
//           upsert: true
//         }
//       };
//     }).filter(op => op !== null); // Remove failed lookups

//     if (ops.length > 0) {
//       await GameCard.bulkWrite(ops);
//       console.log(`✅ Successfully saved ${ops.length} cards to MongoDB for User ${telegramId}`);
//     }
//   } catch (error) {
//     console.error("❌ Error in saveToDatabase:", error);
//   }
// }

//   async function releaseCardsInDb(gameId, releasedCardIds) {
//     if (!releasedCardIds || releasedCardIds.length === 0) return;
//     try {
//       const numericIds = releasedCardIds.map(id => Number(id));
//       await GameCard.updateMany(
//         { gameId: String(gameId), cardId: { $in: numericIds } },
//         { $set: { isTaken: false, takenBy: null } }
//       );
//     } catch (err) {
//       console.error("DB release failed:", err);
//     }
//   }
};
