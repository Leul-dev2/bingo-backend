const mongoose = require("mongoose");
const GameConfiguration = require('../models/GameConfiguration'); // ⭐ Ensure this path is correct for your model
const gameconfig = require('../initialconfig'); // This array should contain your default game configurations

const connectDB = async () => {
    try {
        await mongoose.connect(process.env.MONGO_URI, {
            useNewUrlParser: true,
            useUnifiedTopology: true,
            // useCreateIndex: true, // Deprecated in newer Mongoose, remove if you get warnings
            // useFindAndModify: false, // Deprecated in newer Mongoose, remove if you get warnings
        });
        console.log("✅ MongoDB Connected");
        await createDefaultGameConfigs(); // ⭐ Call this AFTER successful connection
    } catch (error) {
        console.error("❌ MongoDB Connection Error:", error.message);
        process.exit(1);
    }
};

/**
 * Ensures default game configurations are present in the database.
 * It will only insert configurations if they don't already exist based on gameId.
 */
const createDefaultGameConfigs = async () => {
    try {
        if (!gameconfig || gameconfig.length === 0) {
            console.warn("⚠️ No initial game configurations found in 'initialconfig.js'. Skipping default config creation.");
            return;
        }

        for (const config of gameconfig) {
            const existingConfig = await GameConfiguration.findOne({ gameId: config.gameId });

            if (!existingConfig) {
                // If a configuration with this gameId does not exist, create it
                await GameConfiguration.create(config);
                console.log(`➕ Added default game configuration for gameId: ${config.gameId} - "${config.name}"`);
            } else {
                // If it exists, you might want to update it, or just log that it's already there.
                // For initial setup, simply noting its existence is usually sufficient.
                // If you want to allow updates, you would do:
                // await GameConfiguration.findOneAndUpdate({ gameId: config.gameId }, config, { new: true });
                // console.log(`🔄 Updated default game configuration for gameId: ${config.gameId}`);
                console.log(`ℹ️ Game configuration for gameId: ${config.gameId} already exists. Skipping insertion.`);
            }
        }
        console.log("✅ Default game configurations checked/created successfully.");
    } catch (error) {
        console.error("❌ Error creating default game configurations:", error.message);
        // Do not exit process here, as the app might still function without default configs,
        // but games won't start if their config is missing.
    }
};

module.exports = connectDB;