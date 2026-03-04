// resetGame.js  ← FULL PRODUCTION-READY VERSION

const GameControl = require("../models/GameControl");
const { getGameRoomsKey, getGameDrawsKey, getGameDrawStateKey, getActiveDrawLockKey, getGameActiveKey, getGameSessionsKey } = require("./redisKeys");
const { fullGameCleanup } = require("./fullGameCleanup");

async function resetGame(gameId, strGameSessionId, io, state, redis) {
    const strGameId = String(gameId);
    console.log("inside reset Game gamesessionid🤪🤪", strGameSessionId);

    // ── Redis lock to prevent duplicate resets across multiple servers ──
    const resetLockKey = `lock:resetGame:${strGameId}`;
    const lockAcquired = await redis.set(resetLockKey, "1", { NX: true, EX: 15 });
    if (!lockAcquired) {
        console.log(`⛔️ ResetGame already owned by another process for game ${strGameId}. Skipping.`);
        return;
    }

    try {
        console.log(`🧹 Starting FULL reset for game ${strGameId}`);

        // 1. Update GameControl in MongoDB
        const updatedGame = await GameControl.findOneAndUpdate(
            { GameSessionId: strGameSessionId, endedAt: null },
            { $set: { isActive: false, endedAt: new Date() } },
            { new: true }
        );
        console.log(`✅ GameControl updated (endedAt set) for game ${strGameId}:`, updatedGame?._id || "not found");

        // 2. Notify clients (both events for maximum frontend compatibility)
        io?.to(strGameId).emit("gameEnded");
        io?.to(strGameId).emit("gameReset", { gameId: strGameId });
        console.log(`📢 Emitted gameEnded + gameReset to room ${strGameId}`);

        // 3. Clear timeouts/intervals (defense in depth)
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
        if (state?.activeDrawLocks?.[strGameId]) {
            delete state.activeDrawLocks[strGameId];
        }

        // 4. Redis cleanup (consolidated + fixed duplicates)
        await Promise.all([
            redis.set(`gameIsActive:${strGameId}`, "false", "EX", 60),
            redis.del(getGameDrawsKey(strGameSessionId)),
            redis.del(getGameDrawStateKey(strGameSessionId)),   // ← fixed: use sessionId
            redis.del(getActiveDrawLockKey(strGameId)),
            redis.del(getGameSessionsKey(strGameId)),
            redis.del(getGameRoomsKey(strGameId)),
            redis.del(getGameActiveKey(strGameId)),
            redis.del(`gameSessionId:${strGameId}`),
        ]);
        console.log(`✅ Core Redis keys cleared for game ${strGameId}`);

        // 5. Full cleanup (includes countdownOwner, drawing, reset locks, activeDrawLocks, etc.)
        await fullGameCleanup(strGameId, redis, state);

        console.log(`🧼 Game ${strGameId} has been FULLY reset and is ready for next game.`);

    } catch (error) {
        console.error(`❌ Error during resetGame for ${strGameId}:`, error);
        // Still attempt cleanup on error
        await fullGameCleanup(strGameId, redis, state);
    } finally {
        // Always release the lock
        await redis.del(resetLockKey);
    }
}

module.exports = resetGame;