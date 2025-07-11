// models/GameCard.js
const mongoose = require("mongoose");

const GameCardSchema = new mongoose.Schema({
  cardId: {
    type: Number,
    required: true,
    unique: true, // unique within a game
  },
  card: {
    type: [[Number]], // 2D array (e.g., 5x5)
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
    type: String, // telegramId
    default: null,
  },
}, { timestamps: true });

module.exports = mongoose.model("GameCard", GameCardSchema);
