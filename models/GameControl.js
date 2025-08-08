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

  players: { type: [Number], default: [] },
  endedAt: { type: Date },
});

// 🔐 Ensure GameSessionId is unique
gameControlSchema.index({ GameSessionId: 1 }, { unique: true });

module.exports = mongoose.model("GameControl", gameControlSchema);
