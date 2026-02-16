// utils/redisHelpers.js
// Redis helper functions focused on safe, non-blocking operations


// Get my cards (fast & safe) by value
async function findFieldsByValue(redis, hashKey, targetOwnerId, options = {}) {
  console.log(`🔍 🔍 Searching for fields in ${hashKey} with value:`, targetOwnerId);
  const { batchSize = 100 } = options;
  const matches = [];
  let cursor = '0';

  const targetStr = String(targetOwnerId).trim();

  do {
    const scanResult = await redis.hScan(hashKey, cursor, {
      MATCH: '*',
      COUNT: batchSize
    });

    cursor = scanResult.cursor;
    const entries = scanResult.entries || [];

    for (let i = 0; i < entries.length; i += 2) {
      const field = entries[i];
      const value = entries[i + 1];

      if (String(value).trim() === targetStr) {
        matches.push(field);
      }
    }
  } while (cursor !== '0');

  return matches;
}


//Get full taken cards map (safe replacement for hGetAll)
async function getFullHashAsObject(redis, hashKey, options = {}) {
  const { batchSize = 64 } = options;
  const result = {};
  let cursor = '0';

  do {
    const scanResult = await redis.hScan(hashKey, cursor, {
      MATCH: '*',
      COUNT: batchSize
    });

    cursor = scanResult.cursor;
    const entries = scanResult.entries || [];

    for (let i = 0; i < entries.length; i += 2) {
      result[entries[i]] = entries[i + 1];
    }
  } while (cursor !== '0');

  return result;
}



// Batch get specific cards
async function batchHGet(redis, hashKey, fields) {
  if (!fields?.length) return {};

  const multi = redis.multi();
  for (const field of fields) {
    multi.hGet(hashKey, field);
  }

  const results = await multi.exec();

  const obj = {};
  fields.forEach((field, index) => {
    obj[field] = results[index];
  });

  return obj;
}



//
async function safeIncr(redis, key, increment = 1, maxCap = null) {
  const multi = redis.multi();

  multi.incrby(key, increment);

  if (maxCap != null) {
    multi.get(key);
  }

  const results = await multi.exec();

  let newValue = results[0];

  if (maxCap != null && newValue > maxCap) {
    // rollback
    await redis.decrby(key, increment);
    newValue = maxCap;
  }

  return newValue;
}

module.exports = {
  findFieldsByValue,
  getFullHashAsObject,
  batchHGet,
  safeIncr,
};