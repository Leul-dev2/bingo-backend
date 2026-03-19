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

  cartelaIds: { type: [String], required: false }, // The ID of the bingo card, only for winners
  callNumberLength: { type: Number, required: true },

  createdAt: { type: Date, default: Date.now },
});


// ✅ Indexes
gameHistorySchema.index({ stake: 1, eventType: 1, createdAt: -1 });     // Recent Games (public wins)
gameHistorySchema.index({ telegramId: 1, stake: 1, createdAt: -1 });   // My Games (per user)
// For quickly finding all events in a session
gameHistorySchema.index({ sessionId: 1 });

// For quickly finding all history of a player
gameHistorySchema.index({ telegramId: 1 });

// // For queries like: "get a player's history in a given session"
// gameHistorySchema.index({ sessionId: 1, telegramId: 1 });

module.exports = mongoose.model("GameHistory", gameHistorySchema);
