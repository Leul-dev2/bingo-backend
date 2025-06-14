const mongoose = require('mongoose');

const gameControlSchema = new mongoose.Schema({
  gameId: { type: String, required: true },
  isActive: { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now },
  createdBy: { type: String }, // optional: adminId or telegramId
  stakeAmount: { type: Number },
  totalCards: { type: Number },
});

module.exports = mongoose.model("GameControl", gameControlSchema);
