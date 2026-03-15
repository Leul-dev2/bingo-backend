const RATE_LUA = `
local current = redis.call("INCR", KEYS[1])
if current == 1 then redis.call("EXPIRE", KEYS[1], ARGV[1]) end
return current`;

async function checkRateLimit(redis, key, limit, windowSeconds) {
    const current = await redis.eval(RATE_LUA, {
        keys:      [key],
        arguments: [String(windowSeconds)],
    });
    return Number(current) <= limit;
}

module.exports = { checkRateLimit };