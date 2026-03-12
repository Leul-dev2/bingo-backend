// utils/timerQueue.js
//
// Single source of truth for the BullMQ timer queue.
// Imported by:
//   - gameCount.js          (enqueues COUNTDOWN_TICK jobs)
//   - timerWorker.js        (processes COUNTDOWN_TICK + DRAW_TICK jobs)
//   - startDrawing.js       (enqueues DRAW_TICK jobs)
//   - fullGameCleanup.js    (drains/removes jobs on reset)
//
// Why a separate queue from dbQueue?
//   Timer jobs are high-frequency (1/sec) and latency-sensitive.
//   DB-write jobs are low-frequency and can tolerate back-pressure.
//   Mixing them would let a burst of DB writes delay timer ticks.

const { Queue } = require("bullmq");

const { URL } = require("url");

const redisUrl = new URL(process.env.REDIS_URL);

const redisConnection = {
  host: redisUrl.hostname,
  port: redisUrl.port,
  username: redisUrl.username,
  password: redisUrl.password,
  tls: {}
};

// ── Queue ─────────────────────────────────────────────────────────────────────
const timerQueue = new Queue("game-timers", {
    connection: redisConnection,
    defaultJobOptions: {
        removeOnComplete: 1,   // keep only the last completed job (saves memory)
        removeOnFail:     50,  // keep last 50 failed for debugging
        attempts:         1,   // timer ticks must NOT auto-retry — a missed tick
                               // is less harmful than a delayed double-tick
    },
});

// ── Job name constants (avoids magic strings) ─────────────────────────────────
const JOBS = {
    COUNTDOWN_TICK: "COUNTDOWN_TICK",
    DRAW_TICK:      "DRAW_TICK",
    GAME_START:     "GAME_START",   // fired once when countdown reaches 0
};

module.exports = { timerQueue, JOBS, redisConnection };
