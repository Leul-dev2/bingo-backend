// models/GameConfiguration.js
const mongoose = require('mongoose');

const gameConfigurationSchema = new mongoose.Schema({
    gameId: { type: String, required: true, unique: true }, // e.g., "10", "20"
    stakeAmount: { type: Number, required: true },
    defaultTotalCards: { type: Number, default: 0 }, // Default cards per session, or initial player count
    // You could add other config here like `minPlayers`, `maxPlayers`, `drawIntervalSeconds` etc.
    createdAt: { type: Date, default: Date.now },
    lastUpdated: { type: Date, default: Date.now }
});

// Optional: Add a pre-save hook to update lastUpdated
gameConfigurationSchema.pre('save', function(next) {
    this.lastUpdated = new Date();
    next();
});

module.exports = mongoose.model("GameConfiguration", gameConfigurationSchema);