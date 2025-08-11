const mongoose = require('mongoose');

const ledgerSchema = new mongoose.Schema({
    gameSessionId: { type: String, required: true, index: true }, // Links back to the game
    amount: { type: Number, required: true },
    transactionType: { 
        type: String, 
        enum: ['house_profit', 'player_winnings', 'stake_deduction'], 
        required: true 
    },
    description: { type: String },
    telegramId: { type: Number, index: true }, // Optional: Link to a specific player
    createdAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model("Ledger", ledgerSchema);