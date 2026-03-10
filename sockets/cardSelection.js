const GameCard = require("../models/GameCard");
const { checkRateLimit }              = require("../utils/rateLimiter");
const { queueUserUpdate, cleanupBatchQueue } = require("../utils/emitBatcher");
const { dbQueue, defaultJobOptions }  = require("../utils/dbQueue");
const { updateCardSnapshot }          = require("../utils/updateCardSnapshot");

// ─── FIX P1: RELEASE_ALL_LUA — already correct, kept as-is ──────────────────
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

// ─── FIX P1: SELECT_CARDS_LUA rollback now also HDELs gameCardsKey ───────────
// Original rollback only called SREM on takenKey but left stale entries in
// gameCardsKey (the ownership hash).  This meant a card could appear "free"
// in the SET but still show an old owner in the HASH, causing ghost ownership
// bugs visible to other players.
const SELECT_CARDS_LUA = `
local userHeldKey  = KEYS[1]
local takenKey     = KEYS[2]
local gameCardsKey = KEYS[3]

local telegramId  = ARGV[1]
local newCardsCSV = ARGV[2]
local maxAllowed  = tonumber(ARGV[3]) or 2

local newSet = {}
for id in string.gmatch(newCardsCSV, "([^,]+)") do
    newSet[id] = true
end

local oldCards = redis.call("LRANGE", userHeldKey, 0, -1)
local oldSet   = {}
for _, id in ipairs(oldCards) do oldSet[id] = true end

local toAdd = {}
local toReleaseSet = {}

for id, _ in pairs(newSet) do
    if not oldSet[id] then table.insert(toAdd, id) end
end

table.sort(toAdd, function(a, b) return tonumber(a) < tonumber(b) end)

for _, id in ipairs(oldCards) do
    if not newSet[id] then toReleaseSet[id] = true end
end

local baseReleaseCount = 0
for _ in pairs(toReleaseSet) do baseReleaseCount = baseReleaseCount + 1 end
local finalCount = (#oldCards - baseReleaseCount) + #toAdd

if finalCount > maxAllowed then
    local overflow    = finalCount - maxAllowed
    local addedOverflow = 0
    for i = 1, #oldCards do
        local id = oldCards[i]
        if not toReleaseSet[id] then
            toReleaseSet[id] = true
            addedOverflow = addedOverflow + 1
            if addedOverflow >= overflow then break end
        end
    end
    if addedOverflow < overflow then
        return {"LIMIT_REACHED", tostring(maxAllowed)}
    end
end

-- Try to claim new cards atomically
local successfullyAdded = {}
for _, id in ipairs(toAdd) do
    if redis.call("SADD", takenKey, id) == 1 then
        table.insert(successfullyAdded, id)
    else
        -- ─── FIX P1: Rollback BOTH takenKey AND gameCardsKey ────────────
        -- Original only rolled back takenKey (SREM), leaving stale HSET
        -- entries in gameCardsKey that showed wrong ownership to other players.
        for _, c in ipairs(successfullyAdded) do
            redis.call("SREM", takenKey,     c)
            redis.call("HDEL", gameCardsKey, c)  -- ← NEW: clean ownership hash
        end
        return {"CARD_TAKEN", id}
    end
end

local toRelease = {}
for id, _ in pairs(toReleaseSet) do table.insert(toRelease, id) end

for _, id in ipairs(toRelease) do
    redis.call("SREM", takenKey,     id)
    redis.call("LREM", userHeldKey, 0, id)
    redis.call("HDEL", gameCardsKey, id)
end

for _, id in ipairs(toAdd) do
    redis.call("RPUSH", userHeldKey,    id)
    redis.call("HSET",  gameCardsKey,   id, telegramId)
end

table.sort(toRelease, function(a, b) return tonumber(a) < tonumber(b) end)
return {
    "OK",
    table.concat(toAdd,     ","),
    table.concat(toRelease, ",")
}
`;

module.exports = function cardSelectionHandler(socket, io, redis) {

  // ─── Card selection ────────────────────────────────────────────────────────
  socket.on("cardSelected", async (data) => {
    const { telegramId, gameId, cardIds, requestId } = data;

    const rateKey = `rate:select:${telegramId}:${gameId}`;
    const allowed = await checkRateLimit(redis, rateKey, 10, 5);
    if (!allowed) {
      socket.emit("rateLimit", { message: "Too fast selecting cards" });
      return;
    }

    const strTelegramId  = String(telegramId);
    const strGameId      = String(gameId);
    const lockKey        = `lock:userAction:${strGameId}:${strTelegramId}`;
    const userHeldCardsKey = `userHeldCards:${strGameId}:${strTelegramId}`;
    const takenCardsKey  = `takenCards:${strGameId}`;
    const gameCardsKey   = `gameCards:${strGameId}`;

    const hasLock = await redis.set(lockKey, requestId, { NX: true, EX: 2 });
    if (!hasLock) {
      return socket.emit("cardError", { message: "Processing...", requestId });
    }

    try {
      const MAX_CARDS = 2;
      const result = await redis.eval(SELECT_CARDS_LUA, {
        keys:      [userHeldCardsKey, takenCardsKey, gameCardsKey],
        arguments: [strTelegramId, cardIds.map(String).join(","), String(MAX_CARDS)],
      });

      if (result[0] === "LIMIT_REACHED") {
        const current = await redis.lRange(userHeldCardsKey, 0, -1);
        return socket.emit("cardError", {
          message:            `You can hold max ${result[1]} cards`,
          requestId,
          currentHeldCardIds: current.map(Number),
        });
      }

      if (result[0] === "CARD_TAKEN") {
        throw new Error(`CARD_TAKEN:${result[1]}`);
      }

      if (!result || result[0] !== "OK") {
        throw new Error("Card selection failed");
      }

      const added    = result[1] ? result[1].split(",").filter(Boolean) : [];
      const released = result[2] ? result[2].split(",").filter(Boolean) : [];

      const myCurrentCards = await redis.lRange(userHeldCardsKey, 0, -1);

      socket.emit("cardConfirmed", {
        requestId,
        currentHeldCardIds: myCurrentCards.map(Number),
      });

      if (added.length > 0 || released.length > 0) {
        queueUserUpdate(gameId, telegramId, added, released, io);
        await updateCardSnapshot(strGameId, redis);
        console.log(`[SNAPSHOT] Updated after card selection by ${strTelegramId}`);
      }

      // Async DB writes — non-blocking
      try {
        if (added.length > 0) {
          await dbQueue.add(
            "db-write",
            { type: "SAVE_CARDS", payload: { gameId, telegramId, cardIds: added } },
            { ...defaultJobOptions, priority: 1 }
          );
        }
        if (released.length > 0) {
          await dbQueue.add(
            "db-write",
            { type: "RELEASE_CARDS", payload: { gameId, cardIds: released } },
            { ...defaultJobOptions, priority: 2 }
          );
        }
      } catch (queueErr) {
        // Log to your alerting system here (Slack / Telegram / Sentry)
        console.error("Critical: Failed to add job to BullMQ:", queueErr);
      }

    } catch (err) {
      const current = await redis.lRange(userHeldCardsKey, 0, -1);
      socket.emit("cardError", {
        message:            err.message,
        requestId,
        currentHeldCardIds: current.map(Number),
      });
    } finally {
      await redis.del(lockKey);
    }
  });

  // ─── Legacy single-card deselect ──────────────────────────────────────────
  socket.on("cardDeselected", async ({ telegramId, cardId, gameId }) => {
    // Uses RELEASE_ALL_LUA scoped to the single card via the held-list
    // (kept for backward compatibility)
    const result = await redis.eval(RELEASE_ALL_LUA, {
      keys: [
        `takenCards:${gameId}`,
        `userHeldCards:${gameId}:${telegramId}`,
        `gameCards:${gameId}`,
      ],
    });
    if (Array.isArray(result) && result.length > 0) {
      socket.to(gameId).emit("cardReleased", { cardId, telegramId });
    }
  });

  // ─── Unselect all on leave ─────────────────────────────────────────────────
  socket.on("unselectCardOnLeave", async ({ gameId, telegramId }) => {
    const strTelegramId = String(telegramId);
    const strGameId     = String(gameId);

    try {
      console.log(`[UNSELECT ON LEAVE] Processing full release for ${strTelegramId} in game ${strGameId}`);

      const released = await redis.eval(RELEASE_ALL_LUA, {
        keys: [
          `takenCards:${strGameId}`,
          `userHeldCards:${strGameId}:${strTelegramId}`,
          `gameCards:${strGameId}`,
        ],
      });

      if (Array.isArray(released) && released.length > 0) {
        queueUserUpdate(strGameId, strTelegramId, [], released, io);
        console.log(`✅ Queued batched release of ${released.length} cards (unselectCardOnLeave)`);

        await dbQueue.add(
          "db-write",
          { type: "RELEASE_CARDS", payload: { gameId: strGameId, cardIds: released } },
          { ...defaultJobOptions, priority: 2 }
        );

        await updateCardSnapshot(strGameId, redis);
        console.log(`📤 Queued RELEASE_CARDS job to dbWorker`);
      } else {
        console.log(`[UNSELECT ON LEAVE] No cards held by ${strTelegramId}`);
      }
    } catch (err) {
      console.error(`❌ Error in unselectCardOnLeave for ${strTelegramId}:`, err);
    }
  });
};
