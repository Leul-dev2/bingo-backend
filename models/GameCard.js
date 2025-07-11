const mongoose = require("mongoose");

const GameCardSchema = new mongoose.Schema({
  gameId: {
    type: String,
    required: true,
    index: true,
  },
  cardId: {
    type: Number,
    required: true,
  },
  card: {
    type: [[Number]], // 5x5 or similar
    required: true,
  },
  isTaken: {
    type: Boolean,
    default: false,
  },
  takenBy: {
    type: String, // telegramId
    default: null,
  },
}, { timestamps: true });

// ✅ Compound unique index: cardId must be unique within each game
GameCardSchema.index({ gameId: 1, cardId: 1 }, { unique: true });

module.exports = mongoose.model("GameCard", GameCardSchema);
