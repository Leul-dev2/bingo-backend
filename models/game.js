const mongoose = require("mongoose");

const gameSchema = new mongoose.Schema({
  gameId: { type: String, required: true, unique: true },
  entryFee: { type: Number, default: 0 }, // keep but optional
  players: [{ type: Number }],            // telegramIds as numbers
  startedAt: { type: Date, default: Date.now },
  endedAt: { type: Date },
  status: { type: String, enum: ["active", "completed"], default: "active" },
  prizePool: { type: Number, default: 0 },
  winners: [{ type: Number }],            // telegramIds of winners
  board: { type: Array, default: [] },
  winnerPattern: { type: String },
  cartelaId: { type: String },
});

module.exports = mongoose.model("Game", gameSchema);
