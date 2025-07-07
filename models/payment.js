const mongoose = require("mongoose");

const PaymentSchema = new mongoose.Schema({
  tx_ref: {
    type: String,
    required: true,
    unique: true,
  },
  amount: {
    type: String,
    required: true,
  },
  currency: {
    type: String,
    default: "ETB",
  },
  first_name: String,
  last_name: String,
  phone_number: String,
  status: {
    type: String,
    enum: ["pending", "success", "failed"],
    default: "pending",
  },
  webhookTriggered: {
    type: Boolean,
    default: false,
  },
}, { timestamps: true })

module.exports = mongoose.model("Payment", PaymentSchema);


;
