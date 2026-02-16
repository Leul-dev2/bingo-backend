// utils/redisHelpers.js
// Redis helper functions focused on safe, non-blocking operations


// Get my cards (fast & safe) by value
async function findFieldsByValue(redis, hashKey, targetOwnerId, options = {}) {
  console.log(`🔍 Searching ${hashKey} for ID: ${targetOwnerId}`);
  const { batchSize = 100 } = options;
  const matches = [];
  let cursor = '0';

  const targetStr = String(targetOwnerId).trim();

  do {
    const scanResult = await redis.hScan(hashKey, cursor, {
      MATCH: '*',
      COUNT: batchSize
    });
    console.log("DEBUG: Raw scan result entries:", JSON.stringify(scanResult.entries).slice(0, 100));


    cursor = scanResult.cursor;
    
    // Some libraries return scanResult.entries, others just scanResult[1]
    const entries = scanResult.entries || scanResult[1] || [];

    // Handle standard flat array: [field, value, field, value]
    if (Array.isArray(entries) && typeof entries[0] === 'string') {
      for (let i = 0; i < entries.length; i += 2) {
        const value = entries[i + 1];
        if (value && String(value).trim() === targetStr) {
          matches.push(entries[i]);
        }
      }
    } 
    // Handle array of objects: [{field: '8', value: '...'}, ...]
    else {
      for (const item of entries) {
        if (item.value && String(item.value).trim() === targetStr) {
          matches.push(item.field);
        }
      }
    }
  } while (cursor !== '0');

  console.log(`✅ Found matches:`, matches);
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