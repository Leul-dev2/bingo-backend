const GameControl = require("../models/GameControl");
//const redis = require("./redisClient");

async function syncGameIsActive(gameId, isActive, redis) {
    // Only run the atomic update if we are setting the game to 'active' (true)
    if (isActive) {
        try {
            const startedGame = await GameControl.findOneAndUpdate(
                { 
                    gameId, 
                    endedAt: null, 
                    // 🛑 THE CRITICAL FIX: Only update if it's currently NOT active
                    isActive: false 
                }, 
                { 
                    $set: { 
                        isActive: true,
                        startedAt: new Date(), // Optional: Add a startedAt timestamp
                    } 
                },
                { new: true }
            );

            if (!startedGame) {
                // This means the update failed because isActive was already true 
                // (i.e., another concurrent process beat us to it). This is a successful avoidance of the race.
                console.log(`⚠️ Game ${gameId} was already active. Race condition avoided.`);
            } else {
                console.log(`✅ Game ${gameId} successfully started.`);
            }

            // Update Redis based on the attempted status
            await redis.set(`gameIsActive:${gameId}`, isActive ? "true" : "false", "EX", 60);

        } catch (err) {
            console.error(`❌ syncGameIsActive error for game ${gameId}:`, err.message);
        }
    } else {
        // Use the original simple update logic for setting isActive to false (e.g., game end)
        try {
             await GameControl.updateOne(
                { 
                    gameId, 
                    endedAt: null
                }, 
                { isActive }
            );
             // Update Redis
             await redis.set(`gameIsActive:${gameId}`, "false", "EX", 60);

        } catch (err) {
            console.error(`❌ syncGameIsActive error for game ${gameId}:`, err.message);
        }
    }
}

module.exports = syncGameIsActive;