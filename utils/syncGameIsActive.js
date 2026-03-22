// syncGameIsActive.js  ← FULL PRODUCTION-READY VERSION

const GameControl = require("../models/GameControl");

async function syncGameIsActive(gameId, isActive, redis) {
    const strGameId = String(gameId);

    // ── Redis lock (only needed when activating) ──
    if (isActive) {
        const activateLockKey = `lock:syncActivate:${strGameId}`;
        const lockAcquired = await redis.set(activateLockKey, "1", { NX: true, EX: 10 });
        if (!lockAcquired) {
            console.log(`⛔️ syncGameIsActive (activate) already owned by another process for game ${strGameId}`);
            return;
        }

        try {
            console.log(`🔄 Attempting to activate game ${strGameId} (with race protection)`);

            const startedGame = await GameControl.findOneAndUpdate(
                { 
                    gameId: strGameId, 
                    endedAt: null, 
                    isActive: false   // ← This prevents double activation
                }, 
                { 
                    $set: { 
                        isActive: true,
                        startedAt: new Date()
                    } 
                },
                { new: true }
            );

            if (!startedGame) {
                console.log(`⚠️ Game ${strGameId} was already active. Race condition avoided.`);
            } else {
                console.log(`✅ Game ${strGameId} successfully activated.`);
            }

            // Update Redis (5-minute TTL while game is active)
            await redis.set(`gameIsActive:${strGameId}`, "true", "EX", 300);

        } catch (err) {
            console.error(`❌ syncGameIsActive (activate) error for ${strGameId}:`, err.message);
        } finally {
            await redis.del(activateLockKey);   // always release
        }
    } 
    else {
        // ── Deactivation path (simple & safe) ──
        try {
            console.log(`🔄 Deactivating game ${strGameId}`);
            await redis.del(`gameIsActive:${strGameId}`);
            console.log(`✅ Game ${strGameId} deactivated.`);
        } catch (err) {
            console.error(`❌ syncGameIsActive (deactivate) error for ${strGameId}:`, err.message);
        }
    }
}

module.exports = { syncGameIsActive };