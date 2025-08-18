const mongoose = require('mongoose');

const gameHistorySchema = new mongoose.Schema({
  sessionId: { type: String, required: true }, // unique ID per round
  gameId: { type: String, required: true },    // logical game ID (e.g. "10")

  // Player info
  username: { type: String, required: true },
  telegramId: { type: String, required: true },

  eventType: { type: String, required: true, enum: ['win', 'lose'] },

  winAmount: { type: Number, default: 0 },  // Amount won, 0 if lost
  stake: { type: Number, required: true },  // Amount staked

  cartelaId: { type: String, required: false }, // The ID of the bingo card, only for winners
  callNumberLength: { type: Number, required: true },

  createdAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model("GameHistory", gameHistorySchema);
