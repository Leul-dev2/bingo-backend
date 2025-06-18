const mongoose = require('mongoose');

const gameHistorySchema = new mongoose.Schema({
  sessionId: {
    type: String,
    required: true,
  },
  gameId: {
    type: String,
    required: true,
  },
  username: {
    type: String,
    default: 'anonymous',
  },
  telegramId: {
    type: String,
    required: true,
  },
  socketId: {
    type: String,
    required: true,
  },
  cardId: {
    type: Number,
    default: null,
  },
  stake: {
    type: Number,
    default: 0,
  },
  winAmount: {
    type: Number,
    default: 0,
  },
  didWin: {
    type: Boolean,
    default: false,
  },
  joinTime: {
    type: Date,
    default: Date.now,
  },
}, { timestamps: true });

module.exports = mongoose.model('GameHistorySchema', gameHistorySchema);
