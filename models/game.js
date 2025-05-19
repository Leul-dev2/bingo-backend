const mongoose = require("mongoose");

const gameSchema = new mongoose.Schema({
  gameId: { type: String, required: true, unique: true }, // Unique per round/session
  entryFee: { type: Number, required: true },
  players: [{ type: Number }], // Array of telegramIds
  startedAt: { type: Date, default: Date.now },
  status: { type: String, enum: ["active", "completed"], default: "active" },
  prizePool: { type: Number, default: 0 },
});

module.exports = mongoose.model("Game", gameSchema);
