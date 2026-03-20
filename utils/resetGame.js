const GameControl = require("../models/GameControl");
const {
    getGameRoomsKey,
    getGameDrawsKey,
    getGameDrawStateKey,
    getActiveDrawLockKey,
    getGameActiveKey,
    getGameSessionsKey,
} = require("./redisKeys");
const { fullGameCleanup } = require("./fullGameCleanup");

async function resetGame(gameId, GameSessionId, io, state = {}, redis) {
    const strGameId = String(gameId);
    const strGameSessionId = String(GameSessionId);

    console.log(`[resetGame] START ── gameId=${strGameId}, GameSessionId=${strGameSessionId}`);

    // ──────────────────────────────────────────────────────────────
    // 1. Critical: ALWAYS try to mark game as ended in DB
    //    (this part should not be skipped even if lock is held elsewhere)
    // ──────────────────────────────────────────────────────────────
    try {
        console.log("[resetGame] Attempting to update GameControl");

        const updatedGame = await GameControl.findOneAndUpdate(
            { GameSessionId: strGameSessionId },
            { $set: { isActive: false, endedAt: new Date() } },
            { new: true }
        );

        if (updatedGame) {
            console.log("[resetGame] DB SUCCESS ── game marked ended", {
                gameId: strGameId,
                isActive: updatedGame.isActive,
                endedAt: updatedGame.endedAt?.toISOString?.() || updatedGame.endedAt
            });
        } else {
            console.log("[resetGame] DB WARNING ── no document matched or already ended", {
                GameSessionId: strGameSessionId
            });
        }
    } catch (dbErr) {
        console.error("[resetGame] DB update failed:", dbErr);
    }

    // ──────────────────────────────────────────────────────────────
    // 2. Acquire lock for the rest of the cleanup (prevent duplicates)
    // ──────────────────────────────────────────────────────────────
    const lockKey = `lock:resetGame:${strGameId}`;
    const lockAcquired = await redis.set(lockKey, "1", { NX: true, EX: 15 });

    if (!lockAcquired) {
        console.log(`[resetGame] Cleanup skipped ── already running on another instance (${strGameId})`);
        return;
    }

    try {
        console.log(`[resetGame] Lock acquired ── performing cleanup ${strGameId}`);

        // 3. Notify clients
        if (io) {
            io.to(strGameId).emit("gameEnded");
            io.to(strGameId).emit("gameReset", { gameId: strGameId });
            console.log(`[resetGame] Emitted gameEnded + gameReset to room ${strGameId}`);
        }

        // 4. Clear intervals & timeouts ── defensive style
        if (state?.countdownIntervals?.[strGameId]) {
            clearInterval(state.countdownIntervals[strGameId]);
            delete state.countdownIntervals[strGameId];
        }
        if (state?.drawIntervals?.[strGameId]) {
            clearInterval(state.drawIntervals[strGameId]);
            delete state.drawIntervals[strGameId];
        }
        if (state?.drawStartTimeouts?.[strGameId]) {
            clearTimeout(state.drawStartTimeouts[strGameId]);
            delete state.drawStartTimeouts[strGameId];
        }
        if (state?.activeDrawLocks && strGameId in state.activeDrawLocks) {
            delete state.activeDrawLocks[strGameId];
        }

        // 5. Redis cleanup ── fixed duplicates, consistent keys
        await Promise.all([
            redis.del(`gameIsActive:${strGameId}`),
            redis.del(getGameDrawsKey(strGameSessionId)),
            redis.del(getGameDrawStateKey(strGameSessionId)),
            redis.del(getActiveDrawLockKey(strGameId)),
            redis.del(getGameSessionsKey(strGameId)),
            redis.del(getGameRoomsKey(strGameId)),
            redis.del(getGameActiveKey(strGameId)),
            // redis.del(`gameSessionId:${strGameId}`), // only if you really use this key
        ]).catch(redisErr => {
            console.error("[resetGame] Some Redis keys failed to delete:", redisErr);
        });

        console.log(`[resetGame] Redis cleanup finished for ${strGameId}`);

        // 6. Final general cleanup
        await fullGameCleanup(strGameId, redis, state);

        console.log(`[resetGame] FINISHED successfully for ${strGameId}`);
    } catch (err) {
        console.error(`[resetGame] Cleanup error for ${strGameId}:`, err);
    } finally {
        // Always release the lock
        await redis.del(lockKey).catch(() => {});
    }
}

module.exports = resetGame;