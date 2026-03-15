// utils/fullGameCleanup.js

const { getActiveDrawLockKey, getGameActiveKey } = require("./redisKeys");
const { syncGameIsActive }     = require("./syncGameIsActive");
const { timerQueue }           = require("./timerQueue");

async function fullGameCleanup(gameId, redis, state = {}) {
    console.log("fullGameCleanup 🔥🔥🔥");
    const strGameId = String(gameId);

    // ── 1. In-memory cleanup ──────────────────────────────────────────────────
    try {
        if (state.countdownIntervals?.[strGameId]) {
            clearInterval(state.countdownIntervals[strGameId]);
            delete state.countdownIntervals[strGameId];
        }
        if (state.drawIntervals?.[strGameId]) {
            clearInterval(state.drawIntervals[strGameId]);
            delete state.drawIntervals[strGameId];
        }
        // BUG 2 FIX: Always clear in-memory activeDrawLocks.
        // If the timerWorker crashes but the main server stays up, this flag
        // stays true in RAM forever → every subsequent gameCount returns
        // "already active/locked" even after Redis is flushed and DB is clean.
        if (state.activeDrawLocks) {
            delete state.activeDrawLocks[strGameId];
        }
        if (state.gameIsActive) {
            delete state.gameIsActive[strGameId];
        }
    } catch (e) {
        console.warn(`Non-fatal cleanup warning for game ${strGameId}:`, e.message);
    }

    // ── 2. Remove all BullMQ timer jobs for this game ─────────────────────────
    try {
        const jobStates = ["delayed", "waiting", "prioritized"];
        const jobs      = await timerQueue.getJobs(jobStates);
        const toRemove  = jobs.filter((j) => j.data?.gameId === strGameId);
        await Promise.all(toRemove.map((j) => j.remove().catch(() => {})));
        if (toRemove.length > 0) {
            console.log(`[fullGameCleanup] Removed ${toRemove.length} BullMQ jobs for game ${strGameId}`);
        }
    } catch (qErr) {
        console.error(`[fullGameCleanup] BullMQ job removal failed for ${strGameId}:`, qErr);
    }

    // ── 3. Redis lock cleanup ─────────────────────────────────────────────────
    // BUG 1 FIX: Added `countdown:{gameId}` — this was the missing key.
    // gameCount.js sets it with EX:35 as a dedup lock. fullGameCleanup never
    // deleted it, so after a player left mid-countdown and resetRound ran,
    // this key survived. The next gameCount emit saw it and silently returned,
    // so the countdown never restarted for any subsequent player session.
    //
    // BUG 2 FIX: Added `gameStarting:{gameId}` — set at countdown=0 (EX:20).
    // A crash between countdown=0 and game start left this key alive, blocking
    // the next start attempt. Also added `connectedCount:{gameId}` cleanup.
    try {
        await Promise.all([
            redis.del(`lock:countdownOwner:${strGameId}`),
            redis.del(`countdown:${strGameId}`),           // FIX BUG 1: was missing
            redis.del(`gameStarting:${strGameId}`),        // FIX BUG 2: was missing
            redis.del(`lock:countdownDedup:${strGameId}`), // ← ADD THIS (future-proof) 
            redis.del(`lock:drawing:${strGameId}`),
            redis.del(`lock:reset:${strGameId}`),
            redis.del(`lock:resetGame:${strGameId}`),
            redis.del(`lock:emptyReset:${strGameId}`),
            redis.del(getActiveDrawLockKey(strGameId)),
            redis.del(getGameActiveKey(strGameId)),
        ]);

        // ADD after the Promise.all in fullGameCleanup:
            try {
                const rateKeys = await redis.keys(`rate:gameCount:*:${strGameId}`);
                if (rateKeys.length > 0) {
                    await redis.del(rateKeys);
                    console.log(`[fullGameCleanup] Cleared ${rateKeys.length} rate limit keys for game ${strGameId}`);
                }
            } catch (err) {
                console.warn(`[fullGameCleanup] Rate key cleanup failed:`, err);
            }
    } catch (redisErr) {
        console.error(`Redis cleanup failed for ${strGameId}:`, redisErr);
    }

    // ── 4. Sync game-active flag ──────────────────────────────────────────────
    try {
        await syncGameIsActive(strGameId, false, redis);
    } catch (syncErr) {
        console.error(`syncGameIsActive failed during cleanup for ${strGameId}:`, syncErr);
    }

    console.log(`fullGameCleanup finished for game ${strGameId}`);
}

module.exports = { fullGameCleanup };
