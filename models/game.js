const mongoose = require("mongoose");

const gameSchema = new mongoose.Schema({
  gameId: { type: Number, required: true, unique: true },
  players: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }], // Array of players (user references)
  totalPrize: { type: Number, default: 0 }, // Total prize pool for the game
  gameStatus: { type: String, enum: ["waiting", "ongoing", "completed"], default: "waiting" }, // Current status of the game
  winner: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null }, // Winner of the game
  createdAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model("Game", gameSchema);
