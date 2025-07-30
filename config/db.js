const mongoose = require("mongoose");
const GameConfiguration = require('./models/GameConfiguration'); // ⭐ Ensure this path is correct for your model

// Note: The 'gameconfig' import is no longer needed if you are hardcoding values here.
// const gameconfig = require('../initialconfig'); // You can remove this line if initialconfig.js is not used.

const connectDB = async () => {
    try {
        await mongoose.connect(process.env.MONGO_URI, {
            useNewUrlParser: true,
            useUnifiedTopology: true,
            // Deprecated options, remove if you get warnings in newer Mongoose versions
            // useCreateIndex: true,
            // useFindAndModify: false,
        });
        console.log("✅ MongoDB Connected");
        await createDefaultGameConfigs(); // ⭐ Call this AFTER successful connection
    } catch (error) {
        console.error("❌ MongoDB Connection Error:", error.message);
        process.exit(1);
    }
};

/**
 * Ensures default game configurations are present in the database using upsert.
 * This function will create the configurations if they don't exist, or update them if they do.
 */
async function createDefaultGameConfigs() {
    try {
        console.log("Checking/ensuring default game configurations...");

        await GameConfiguration.findOneAndUpdate(
            { gameId: "10" },
            { $set: { stakeAmount: 10, defaultTotalCards: 0 } },
            { upsert: true, new: true, setDefaultsOnInsert: true } // ⭐ Added setDefaultsOnInsert
        );
        await GameConfiguration.findOneAndUpdate(
            { gameId: "20" },
            { $set: { stakeAmount: 20, defaultTotalCards: 0 } },
            { upsert: true, new: true, setDefaultsOnInsert: true }
        );
        await GameConfiguration.findOneAndUpdate(
            { gameId: "30" },
            { $set: { stakeAmount: 30, defaultTotalCards: 0 } },
            { upsert: true, new: true, setDefaultsOnInsert: true }
        );
        await GameConfiguration.findOneAndUpdate(
            { gameId: "100" },
            { $set: { stakeAmount: 100, defaultTotalCards: 0 } },
            { upsert: true, new: true, setDefaultsOnInsert: true }
        );
        console.log("✅ Default game configurations ensured.");
    } catch (error) {
        console.error("❌ Error creating default game configurations:", error);
    }
}

module.exports = connectDB;