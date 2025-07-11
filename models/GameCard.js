const mongoose = require("mongoose");

const GameCardSchema = new mongoose.Schema({
  cardId: {
    type: Number,
    required: true,
  },
  card: {
    type: [[Number]],
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
    default: null,
  },
}, { timestamps: true });

// ✅ Ensure (gameId + cardId) is unique per game
GameCardSchema.index({ gameId: 1, cardId: 1 }, { unique: true });

module.exports = mongoose.model("GameCard", GameCardSchema);
