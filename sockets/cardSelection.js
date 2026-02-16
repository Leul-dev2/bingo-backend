// socket/handlers/cardSelection.js

const GameCard = require("../models/GameCard");
const { getFullHashAsObject, findFieldsByValue } = require('../utils/redisHelpers'); // your helpers

module.exports = function registerCardSelectionHandlers(socket, io, redis) {
socket.on("cardSelected", async (data) => {
    const { telegramId, gameId, cardIds = [], cardsData = {}, requestId } = data;

    const strTelegramId = String(telegramId).trim();
    const strGameId     = String(gameId);
    const userLockKey   = `lock:userAction:${strGameId}:${strTelegramId}`;

    // ─── Early validation ───────────────────────────────────────────────
    if (!requestId || !Array.isArray(cardIds) || cardIds.length > 2) {
      return socket.emit("cardError", {
        message: "Invalid selection: 0–2 cards with requestId required",
        requestId
      });
    }

    const startTime = Date.now();
    console.log(`[cardSelected] ${strTelegramId} → ${cardIds.join(', ')} (req:${requestId})`);

    // ─── 1. User-level lock (prevent concurrent actions) ─────────────────
    const lockAcquired = await redis.set(userLockKey, requestId, { NX: true, EX: 12 });
    if (!lockAcquired) {
      return socket.emit("cardError", {
        message: "⏳ Previous action still processing. Please wait 1–2 seconds.",
        requestId
      });
    }

    let cardLocks = [];

    try {
        // --- Idempotency Check ---
      const lastProcessedId = await redis.hGet("userLastRequestId", strTelegramId);
      if (lastProcessedId === requestId) {
          console.log(`[cardSelected] Duplicate request detected for ${requestId}. Skipping.`);
          
          // Use your safe helper to get current state for the reply
          const currentOwned = await findFieldsByValue(redis, `gameCards:${strGameId}`, strTelegramId);
          
          return socket.emit("cardConfirmed", {
              cardIds: currentOwned.map(Number),
              requestId
          });
      }


      const gameCardsKey = `gameCards:${strGameId}`;

      // ─── 2. Get my current cards (safe HSCAN) ───────────────────────────
      const myCurrentCards = await findFieldsByValue(redis, gameCardsKey, strTelegramId);
      const myOldSet = new Set(myCurrentCards.map(String));
      const newSet   = new Set(cardIds.map(String));

      const toAdd     = [...newSet].filter(id => !myOldSet.has(id));
      const toRelease = [...myOldSet].filter(id => !newSet.has(id));

      // ─── 3. Atomic conflict check + lock acquisition via pipeline ───────
      if (toAdd.length > 0) {
        const multi = redis.multi();
        const lockKeys = [];

        for (const cardId of toAdd) {
          const lockKey = `lock:card:${strGameId}:${cardId}`;
          lockKeys.push(lockKey);

          multi.hGet(gameCardsKey, cardId);                    // check owner
          multi.set(lockKey, strTelegramId, { NX: true, EX: 10 }); // try lock
        }

        const results = await multi.exec();

        cardLocks = [];

        for (let i = 0; i < toAdd.length; i++) {
          const owner     = results[i * 2];       // hGet result
          const lockOk    = results[i * 2 + 1];   // set result

          if (owner && owner !== strTelegramId) {
            throw new Error(`Card ${toAdd[i]} is already taken.`);
          }
          if (!lockOk) {
            throw new Error(`Card ${toAdd[i]} is currently being claimed by someone else.`);
          }

          cardLocks.push(lockKeys[i]);
        }
      }

      // ─── 4. Atomic updates ──────────────────────────────────────────────
      const redisMulti = redis.multi();
      const dbPromises = [];

      // Release old cards
      if (toRelease.length > 0) {
        redisMulti.hDel(gameCardsKey, ...toRelease);
        dbPromises.push(
          GameCard.updateMany(
            { gameId: strGameId, cardId: { $in: toRelease.map(Number) } },
            { $set: { isTaken: false, takenBy: null } }
          )
        );
      }

      // Add new cards
      if (toAdd.length > 0) {
        for (const cardId of toAdd) {
          const strCardId = String(cardId);
          const grid = cardsData[strCardId];

          if (!grid || !Array.isArray(grid) || grid.length !== 5) {
            throw new Error(`Invalid or missing card data for card ${strCardId}`);
          }

          const cleanGrid = grid.map(row =>
            row.map(cell => (cell === "FREE" ? 0 : Number(cell)))
          );

          dbPromises.push(
            GameCard.updateOne(
              { gameId: strGameId, cardId: Number(strCardId) },
              { $set: { card: cleanGrid, isTaken: true, takenBy: strTelegramId } },
              { upsert: true }
            )
          );

          redisMulti.hSet(gameCardsKey, strCardId, strTelegramId);
        }
      }

      // Update user session (last selected card or clear)
      const lastCardId = cardIds.length > 0 ? String(cardIds[cardIds.length - 1]) : null;

      if (lastCardId && cardsData[lastCardId]) {
        const lastGrid = cardsData[lastCardId];
        const cleanLast = lastGrid.map(r => r.map(c => (c === "FREE" ? 0 : Number(c))));

        const payload = JSON.stringify({
          telegramId: strTelegramId,
          cardId: lastCardId,
          card: cleanLast,
          gameId: strGameId,
          timestamp: Date.now()
        });

        redisMulti.hSet("userSelections", socket.id, payload);
        redisMulti.hSet("userSelectionsByTelegramId", strTelegramId, payload);
      } else {
        redisMulti.hDel("userSelections", socket.id);
        redisMulti.hDel("userSelectionsByTelegramId", strTelegramId);
      }

      redisMulti.hSet("userLastRequestId", strTelegramId, requestId);

      // Execute Redis + MongoDB
      await Promise.all([
        redisMulti.exec(),
        ...dbPromises
      ]);

      // ─── 5. Delta broadcasts (best for performance & smoothness) ────────
      for (const cardId of toRelease) {
        io.to(strGameId).emit("cardReleased", { telegramId: strTelegramId, cardId });
      }

      for (const cardId of toAdd) {
        io.to(strGameId).emit("otherCardSelected", { telegramId: strTelegramId, cardId });
      }

      socket.emit("cardConfirmed", {
        cardIds: Array.from(newSet).map(Number),
        requestId
      });

      // Optional: player count (cheap O(1) call)
      const playerCount = await redis.sCard(`gameSessions:${strGameId}`);
      io.to(strGameId).emit("gameid", { gameId: strGameId, numberOfPlayers: playerCount });

      console.log(`[cardSelected] SUCCESS in ${Date.now() - startTime}ms → ${strTelegramId} now holds ${cardIds.length} cards`);

    } catch (err) {
      console.error(`[cardSelected] ERROR ${strTelegramId} ${strGameId}:`, err);

      // Send current real state so UI can recover correctly
      const currentOwned = await findFieldsByValue(redis, `gameCards:${strGameId}`, strTelegramId);

      socket.emit("cardError", {
        message: err.message || "Failed to update card selection.",
        requestId,
        currentHeldCardIds: currentOwned.map(Number)
      });

    } finally {
      // ─── Always clean up locks ────────────────────────────────────────
      const cleanup = redis.multi();
      cleanup.del(userLockKey);

      if (cardLocks?.length > 0) {
        cardLocks.forEach(k => cleanup.del(k));
      }

      await cleanup.exec();
    }
  });

  // ──────────────────────────────────────────────
  // cardDeselected (single card release)
  // ──────────────────────────────────────────────
  socket.on("cardDeselected", async ({ telegramId, cardId, gameId }) => {
    const strTelegramId = String(telegramId).trim();
    const strCardId     = String(cardId);
    const strGameId     = String(gameId);
    const key           = `gameCards:${strGameId}`;

    try {
      const owner = await redis.hGet(key, strCardId);
      if (owner !== strTelegramId) {
        return socket.emit("cardError", { message: "Not your card" });
      }

      await Promise.all([
        redis.hDel(key, strCardId),
        GameCard.updateOne(
          { gameId: strGameId, cardId: Number(strCardId) },
          { $set: { isTaken: false, takenBy: null } }
        )
      ]);

      io.to(strGameId).emit("cardReleased", {
        telegramId: strTelegramId,
        cardId: strCardId
      });

      socket.emit("cardDeselectedConfirmed", { cardId: strCardId });
    } catch (err) {
      console.error("[cardDeselected] ERROR:", err);
      socket.emit("cardError", { message: "Failed to deselect card" });
    }
  });

  // ──────────────────────────────────────────────
  // unselectCardOnLeave (cleanup on leave/disconnect)
  // ──────────────────────────────────────────────
  socket.on("unselectCardOnLeave", async ({ gameId, telegramId }) => {
    const strGameId     = String(gameId);
    const strTelegramId = String(telegramId).trim();
    const key           = `gameCards:${strGameId}`;

    try {
      // Find all cards owned by this user (HSCAN – safe)
      const cardsToRelease = await findFieldsByValue(redis, key, strTelegramId);

      if (cardsToRelease.length > 0) {
        console.log(`[unselectCardOnLeave] Releasing ${cardsToRelease.length} cards for ${strTelegramId}`);

        // Redis + DB update
        await Promise.all([
          redis.hDel(key, ...cardsToRelease),
          GameCard.updateMany(
            { gameId: strGameId, cardId: { $in: cardsToRelease.map(Number) } },
            { $set: { isTaken: false, takenBy: null } }
          )
        ]);

        // Double-check leftovers (rare race condition)
        const verify = await findFieldsByValue(redis, key, strTelegramId);
        if (verify.length > 0) {
          console.warn(`Leftovers after release: ${verify.join(', ')}`);
          await redis.hDel(key, ...verify);
        }

        // Notify everyone
        io.to(strGameId).emit("cardsReleased", {
          cardIds: cardsToRelease,
          telegramId: strTelegramId
        });
      }

      // Clean session keys
      await Promise.all([
        redis.hDel("userSelections", socket.id),
        redis.hDel("userSelectionsByTelegramId", strTelegramId),
        redis.del(`activeSocket:${strTelegramId}:${socket.id}`),
        redis.sRem(`gameSessions:${strGameId}`, strTelegramId),
        redis.sRem(`gameRooms:${strGameId}`, strTelegramId)
      ]);

      // Update player count
      const count = await redis.sCard(`gameRooms:${strGameId}`);
      io.to(strGameId).emit("playerCountUpdate", { gameId: strGameId, playerCount: count });

    } catch (err) {
      console.error("[unselectCardOnLeave] ERROR:", err);
    }
  });
};