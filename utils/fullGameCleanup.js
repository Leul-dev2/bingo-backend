// utils/fullGameCleanup.js
//
// What changed:
//
//   BEFORE: clearInterval(state.drawIntervals[gameId])
//           clearInterval(state.countdownIntervals[gameId])
//           — only worked on the process that owned the interval.
//             On a different process, state was empty → interval lived on.
//
//   AFTER:  Removes all queued BullMQ timer jobs for this game from Redis.
//           Works from ANY process because BullMQ jobs live in Redis, not RAM.
//           The in-memory clearInterval calls are kept as no-ops for safety
//           (they are harmless and cover the edge case where this cleanup runs
//           on the same process as timerWorker in a single-process dev setup).

const { getActiveDrawLockKey } = require("./redisKeys");
const { syncGameIsActive }     = require("./syncGameIsActive");
const { timerQueue }           = require("./timerQueue");

async function fullGameCleanup(gameId, redis, state = {}) {
    console.log("fullGameCleanup 🔥🔥🔥");
    const strGameId = String(gameId);

    // ── 1. In-memory cleanup (no-ops if timerWorker is separate process) ──────
    try {
        if (state.countdownIntervals?.[strGameId]) {
            clearInterval(state.countdownIntervals[strGameId]);
            delete state.countdownIntervals[strGameId];
        }
        if (state.drawIntervals?.[strGameId]) {
            clearInterval(state.drawIntervals[strGameId]);
            delete state.drawIntervals[strGameId];
        }
        if (state.activeDrawLocks && strGameId in state.activeDrawLocks) {
            delete state.activeDrawLocks[strGameId];
        }
    } catch (e) {
        console.warn(`Non-fatal cleanup warning for game ${strGameId}:`, e.message);
    }

    // ── 2. Remove all BullMQ timer jobs for this game ─────────────────────────
    //
    //  Job IDs follow the pattern:
    //    countdown:{gameId}:{N}
    //    draw:{gameId}:{N}
    //    gameStart:{gameId}:{sessionId}
    //
    //  We remove them all by pattern. BullMQ's getJobs() lets us filter by state.
    //  We target delayed + waiting jobs — active jobs finish naturally (they are
    //  single-tick operations that complete in <100ms and will see the reset flag).
    try {
        const jobStates = ["delayed", "waiting", "prioritized"];
        const jobs      = await timerQueue.getJobs(jobStates);

        const toRemove = jobs.filter(
            (j) => j.data?.gameId === strGameId
        );

        await Promise.all(toRemove.map((j) => j.remove().catch(() => {})));

        if (toRemove.length > 0) {
            console.log(`[fullGameCleanup] Removed ${toRemove.length} BullMQ timer jobs for game ${strGameId}`);
        }
    } catch (qErr) {
        console.error(`[fullGameCleanup] BullMQ job removal failed for ${strGameId}:`, qErr);
    }

    // ── 3. Redis lock cleanup ─────────────────────────────────────────────────
    try {
        await Promise.all([
            redis.del(`lock:countdownOwner:${strGameId}`),
            redis.del(`lock:drawing:${strGameId}`),
            redis.del(`lock:reset:${strGameId}`),
            redis.del(`lock:resetGame:${strGameId}`),
            redis.del(getActiveDrawLockKey(strGameId)),
        ]);
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
