const mongoose = require("mongoose");

const WithdrawalSchema = new mongoose.Schema({
  tx_ref: { type: String, required: true, unique: true },
  telegramId: { type: String, required: true },
  bank_code: String,
  account_name: String,
  account_number: String,
  amount: { type: Number, required: true },
  currency: { type: String, default: "ETB" },
  status: { 
    type: String, 
    enum: ["pending", "processing", "paid", "failed", "rejected"], 
    default: "pending" 
  },
  reviewed: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model("Withdrawal", WithdrawalSchema);
