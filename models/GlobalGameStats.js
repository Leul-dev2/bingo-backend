const mongoose = require('mongoose');

const globalGameStatsSchema = new mongoose.Schema({
    date: { 
        type: Date, 
        required: true,
        unique: true 
    },
    gamesPlayed: { 
        type: Number, 
        default: 0 
    }
}, { 
    
    timestamps: true 
});

const GlobalGameStats = mongoose.model('GlobalGameStats', globalGameStatsSchema);

module.exports = GlobalGameStats;