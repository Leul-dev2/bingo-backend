const mongoose = require('mongoose');

const ledgerSchema = new mongoose.Schema({
    gameSessionId: { type: String, required: true, index: true },
    amount: { type: Number, required: true },
    transactionType: { 
        type: String, 
        enum: ['house_profit', 'player_winnings', 'stake_deduction', 'stake_refund', 'bonus_stake_deduction', 'bonus_stake_refund'], // ⭐ Added 'stake_refund'
        required: true 
    },
    description: { type: String },
    telegramId: { type: Number, index: true },
    createdAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model("Ledger", ledgerSchema);