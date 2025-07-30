const mongoose = require('mongoose');

const gameControlSchema = new mongoose.Schema({
    gameId: { type: String, required: true }, // This now represents the 'type' of game (e.g., "10" for stake 10)
    sessionId: { type: String, required: true, unique: true }, // This is the unique instance ID
    isActive: { type: Boolean, default: false },
    createdAt: { type: Date, default: Date.now },
    createdBy: { type: String }, // adminId or telegramId

    stakeAmount: { type: Number, required: true },  // per player
    totalCards: { type: Number, required: true },   // players at game start
    prizeAmount: { type: Number, required: true },  // stake * totalCards

    players: { type: [Number], default: [] }, // 🟢 Add this line to track telegramId list

    endedAt: { type: Date }, // optional: to mark when game finishes

    // --- NEW FIELDS FOR WINNER/GAME RESULT ---
    winnerTelegramId: { type: Number }, // Telegram ID of the winning user
    winnerUsername: { type: String }, // Username of the winning user
    winningCardId: { type: Number }, // The card ID that won
    finalPrizeAmount: { type: Number }, // The exact prize amount awarded (might be same as prizeAmount, but good for clarity)
    winningPattern: { type: [[Boolean]] }, // Store the winning pattern (e.g., [[false, true, false], ...])
    drawnNumbersAtWin: { type: [Number] }, // All numbers drawn when the game concluded
    // --- END NEW FIELDS ---
});

module.exports = mongoose.model("GameControl", gameControlSchema);