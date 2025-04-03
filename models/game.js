const mongoose = require("mongoose");

const gameSchema = new mongoose.Schema({
  gameId: { type: Number, required: true, unique: true },
  players: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
  totalPrize: { type: Number, default: 0 },
  gameStatus: { type: String, enum: ["waiting", "ongoing", "completed"], default: "waiting" },
  winner: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  createdAt: { type: Date, default: Date.now },
  timerStart: { type: Date, default: null }, // This will hold the start time for the 15-second timer
});

module.exports = mongoose.model("Game", gameSchema);
