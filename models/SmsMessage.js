const mongoose = require('mongoose');

const SmsMessageSchema = new mongoose.Schema({
  from: { type: String, required: true },
  message: { type: String, required: true },
  timestamp: { type: Number, default: Date.now },
  gateway: { type: String, default: 'default' },
  status: { type: String, enum: ['pending', 'processed'], default: 'pending' },
});

module.exports = mongoose.model('SmsMessage', SmsMessageSchema);
