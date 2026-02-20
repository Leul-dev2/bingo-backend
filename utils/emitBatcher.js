
const batchQueues = new Map();

function getOrCreateQueue(gameId) {
  if (!batchQueues.has(gameId)) {
    batchQueues.set(gameId, {
      timer: null,
      updates: new Map(),
    });
  }
  return batchQueues.get(gameId);
}


function queueUserUpdate(gameId, ownerId, added, released, io) {
  const queue = getOrCreateQueue(gameId);
  const strOwnerId = String(ownerId);

  if (!queue.updates.has(strOwnerId)) {
    queue.updates.set(strOwnerId, {
      selected: new Set(),
      released: new Set(),
    });
  }

  const userUpdates = queue.updates.get(strOwnerId);

  added.forEach(id => userUpdates.selected.add(Number(id)));
  released.forEach(id => userUpdates.released.add(Number(id)));

  // Reset / schedule flush
  if (queue.timer) {
    clearTimeout(queue.timer);
  }
  queue.timer = setTimeout(() => flushBatchUpdates(gameId, io), 60); // 60 ms
}

function flushBatchUpdates(gameId, io) {
  const queue = batchQueues.get(gameId);
  if (!queue || queue.updates.size === 0) return;

  const batchPayload = {
    updates: [],
  };

  queue.updates.forEach((userUpdates, ownerId) => {
    batchPayload.updates.push({
      ownerId,
      selected: Array.from(userUpdates.selected),
      released: Array.from(userUpdates.released),
    });
  });

  // Emit once per flush
  io.to(gameId).emit("batchCardsUpdated", batchPayload);

  // Clean up
  queue.updates.clear();
  queue.timer = null;

  // Optional: remove empty queue entirely
  if (queue.updates.size === 0) {
    batchQueues.delete(gameId);
  }
}

function cleanupBatchQueue(gameId) {
  const queue = batchQueues.get(gameId);
  if (queue?.timer) {
    clearTimeout(queue.timer);
  }
  batchQueues.delete(gameId);
}


module.exports = {
  queueUserUpdate,
  cleanupBatchQueue,
};