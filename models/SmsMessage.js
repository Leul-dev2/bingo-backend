// models/SmsMessage.js
const mongoose = require("mongoose");

const SmsMessageSchema = new mongoose.Schema({
  from: { type: String, required: true },      // Sender phone number
  message: { type: String, required: true },   // SMS text body
  timestamp: { type: Date, default: Date.now },// When received
  gateway: { type: String },                   // (Optional) Gateway ID from SMSSync
  status: { type: String, default: "pending" } // pending | processed
});

module.exports = mongoose.model("SmsMessage", SmsMessageSchema);
