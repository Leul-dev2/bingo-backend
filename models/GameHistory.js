const mongoose = require("mongoose");

const winnerSchema = new mongoose.Schema({
  telegramId: String,
  username: String,
  board: [Number],
  winnerPattern: String,
  boardNumber: Number,
  prizeAmount: Number,
}, { _id: false });

const gameHistorySchema = new mongoose.Schema({
  gameId: { type: String, required: true, unique: true },
  stake: Number,
  totalPlayers: Number,
  startTime: Date,
  endTime: Date,
  numbersDrawn: [Number],
  winner: winnerSchema, // for now a single winner
}, {
  timestamps: true
});

module.exports = mongoose.model("GameHistory", gameHistorySchema);
