const mongoose = require("mongoose");

const GameCardSchema = new mongoose.Schema({
  cardId: {
    type: Number,
    required: true,
  },
  card: {
    type: [[Number]], // 5x5 grid (ideally validate structure in logic)
    required: true,
  },
  gameId: {
    type: String,
    required: true,
    index: true,
  },
  isTaken: {
    type: Boolean,
    default: false,
  },
  takenBy: {
    type: String,
    default: null, // Telegram ID or other identifier
  },
}, {
  timestamps: true,
});

// ✅ Compound unique index to prevent duplicate cardId per game
GameCardSchema.index({ gameId: 1, cardId: 1 }, { unique: true });

module.exports = mongoose.model("GameCard", GameCardSchema);
