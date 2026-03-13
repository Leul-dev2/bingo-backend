// utils/isGameLockedOrActive.js
const GameControl = require("../models/GameControl");
const { getActiveDrawLockKey, getGameActiveKey } = require("./redisKeys");

async function isGameLockedOrActive(gameId, redis, state) {
    const strGameId = String(gameId);

    // ── 1. Redis fast-path checks only (no in-memory state) ──────────────────
    // state.activeDrawLocks is intentionally NOT checked here.
    // Reason: after any crash or restart, in-memory state is stale/empty but
    // the flag may still be true from before the crash → false positive lock.
    const [redisHasLock, redisIsActive] = await Promise.all([
        redis.get(getActiveDrawLockKey(strGameId)),
        redis.get(getGameActiveKey(strGameId)),
    ]);

    if (redisHasLock === "true" || redisIsActive === "true") {
        console.log(`[isGameLockedOrActive] Redis lock active for ${strGameId}`);
        return true;
    }

    // ── 2. DB check — source of truth ────────────────────────────────────────
    const activeGame = await GameControl.findOne({
        gameId:   strGameId,
        isActive: true,
        endedAt:  null,
    }).select("_id updatedAt createdAt").lean();

    if (!activeGame) {
        return false; // Clean state — no lock anywhere
    }

    // ── 3. Stale crash detection ──────────────────────────────────────────────
    // DB says isActive:true but Redis has no locks. Two possibilities:
    //   A) Race: game just started, Redis not yet synced (fine, return true)
    //   B) Crash: game never ended, stuck forever (auto-heal)
    //
    // We distinguish them by age: if the record has been "active" for >30min
    // with no Redis locks, it's a crashed game — heal it and return false.
    const recordAge = Date.now() - new Date(activeGame.updatedAt || activeGame.createdAt).getTime();
    const STALE_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes

    if (recordAge > STALE_THRESHOLD_MS) {
        console.warn(`[isGameLockedOrActive] Stale lock detected for ${strGameId} (${Math.round(recordAge / 60000)}min old) — auto-healing DB`);
        await GameControl.findByIdAndUpdate(activeGame._id, {
            $set: { isActive: false, endedAt: new Date() },
        });
        return false; // Treat as clean so a new game can start
    }

    // ── 4. Genuinely active game — fix out-of-sync Redis ─────────────────────
    console.warn(`[isGameLockedOrActive] DB active but Redis stale for ${strGameId} — resyncing Redis`);
    await redis.set(getGameActiveKey(strGameId), "true", { EX: 1800 });
    return true;
}

module.exports = { isGameLockedOrActive };
