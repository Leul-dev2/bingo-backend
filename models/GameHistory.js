const mongoose = require('mongoose');

const gameHistorySchema = new mongoose.Schema({
  sessionId: { type: String, required: true }, // unique ID per round
  gameId: { type: String, required: true },    // logical game ID (e.g. "10")

  // Player info
  username: { type: String, required: true },
  telegramId: { type: String, required: true },

  // Game outcome
  winAmount: { type: Number, required: true },
  stake: { type: Number, required: true },
  
  // Timestamps
  createdAt: { type: Date, default: Date.now }, // stores date + time
});

module.exports = mongoose.model("GameHistory", gameHistorySchema);
