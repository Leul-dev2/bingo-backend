// utils/startDrawing.js
//
// What changed:
//
//   BEFORE: setInterval(drawOneTick, 2000) stored in state.drawIntervals[gameId]
//           — dies silently if the process crashes; no more numbers drawn.
//
//   AFTER:  Enqueues the first DRAW_TICK BullMQ job (delay=2000ms).
//           timerWorker processes it: draws one number, persists state in Redis,
//           broadcasts via "game-events" pub/sub, and re-enqueues the next
//           DRAW_TICK with delay=2000ms.
//           The draw survives process crashes automatically.
//
//   The draw state (shuffled numbers array + current index) is stored in Redis
//   under getGameDrawStateKey(gameSessionId) by prepareNewGame — already done.
//   timerWorker reads and advances this state each tick.
//
//   state.drawIntervals is no longer written here.

const { timerQueue, JOBS } = require("./timerQueue");

async function startDrawing(gameId, gameSessionId, io, state, redis) {
    const strGameId        = String(gameId);
    const strGameSessionId = String(gameSessionId);

    console.log(`[startDrawing] Enqueuing first DRAW_TICK for game ${strGameId}`);

    // Remove any leftover draw jobs for this game (safety on restart/retry)
    await timerQueue.remove(`draw-${strGameId}-${strGameSessionId}-0`).catch(() => {});

    // Enqueue first draw tick — timerWorker chains the rest automatically
    await timerQueue.add(
        JOBS.DRAW_TICK,
        { gameId: strGameId, gameSessionId: strGameSessionId },
        {
            delay:            2000,          // 2 seconds after game start
            jobId:            `draw-${strGameId}-${strGameSessionId}-0`,            
            attempts:         1,
            removeOnComplete: 1,
            removeOnFail:     10,
        }
    );

    console.log(`✅ Draw sequence started for game ${strGameId}`);
}

module.exports = { startDrawing };
