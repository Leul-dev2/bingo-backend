// Example of how you might create initial configurations (run once)
const GameConfiguration = require('./models/GameConfiguration');
async function createDefaultGameConfigs() {
    try {
        await GameConfiguration.findOneAndUpdate(
            { gameId: "10" },
            { $set: { stakeAmount: 10, defaultTotalCards: 0 } },
            { upsert: true, new: true }
        );
        await GameConfiguration.findOneAndUpdate(
            { gameId: "20" },
            { $set: { stakeAmount: 20, defaultTotalCards: 0 } },
            { upsert: true, new: true }
        );
         await GameConfiguration.findOneAndUpdate(
            { gameId: "30" },
            { $set: { stakeAmount: 30, defaultTotalCards: 0 } },
            { upsert: true, new: true }
        );
         await GameConfiguration.findOneAndUpdate(
            { gameId: "100" },
            { $set: { stakeAmount: 100, defaultTotalCards: 0 } },
            { upsert: true, new: true }
        );
        console.log("Default game configurations ensured.");
    } catch (error) {
        console.error("Error creating default game configurations:", error);
    }
}
