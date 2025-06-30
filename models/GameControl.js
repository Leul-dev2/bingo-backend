const mongoose = require('mongoose');

const gameControlSchema = new mongoose.Schema({
  gameId: { type: String, required: true },
  isActive: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now },
  createdBy: { type: String }, // adminId or telegramId

  stakeAmount: { type: Number, required: true },  // per player
  totalCards: { type: Number, required: true },   // players at game start
  prizeAmount: { type: Number, required: true },  // stake * totalCards

  players: { type: [Number], default: [] }, // 🟢 Add this line to track telegramId list

  endedAt: { type: Date }, // optional: to mark when game finishes
});


module.exports = mongoose.model("GameControl", gameControlSchema);
