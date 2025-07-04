const mongoose = require("mongoose");

const PaymentSchema = new mongoose.Schema({
  tx_ref: {
    type: String,
    required: true,
    unique: true,
  },
  email: {
    type: String,
    required: true,
  },
  amount: {
    type: String,
    required: true,
  },
  status: {
    type: String,
    enum: ["pending", "success", "failed"],
    default: "pending",
  },
  webhookTriggered: {
    type: Boolean,
    default: false, // false until webhook updates it
  },
}, { timestamps: true });

module.exports = mongoose.model("Payment", PaymentSchema);
