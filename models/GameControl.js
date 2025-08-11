const mongoose = require('mongoose');

const gameControlSchema = new mongoose.Schema({
  GameSessionId: { type: String, required: true }, // unique ID per round
  gameId: { type: String, required: true }, 
  isActive: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now },
  createdBy: { type: String },
  stakeAmount: { type: Number, required: true },
  totalCards: { type: Number, required: true },
  prizeAmount: { type: Number, required: true },
  houseProfit: {
    type: Number,
    required: true, 
  },
  players: [{
      telegramId: { type: Number, required: true },
      status: { type: String, enum: ['connected', 'disconnected'], default: 'connected' }
  }],
  endedAt: { type: Date },
});

// ⭐ This is the correct index to prevent the race condition.
// It enforces that there can only be ONE document with a given `gameId`
// and `isActive: false` (i.e., one lobby).
gameControlSchema.index(
    { gameId: 1, isActive: 1 },
    { unique: true, partialFilterExpression: { isActive: false } }
);

module.exports = mongoose.model("GameControl", gameControlSchema);