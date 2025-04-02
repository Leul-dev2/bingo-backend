const mongoose = require("mongoose");

const userSchema = new mongoose.Schema({
    telegramId: { type: Number, required: true, unique: true },
    username: { type: String, default: "Unknown" },
    accountNumber: { type: Number, unique: true, required: true },
    phoneNumber: { type: String, required: true }, // 🟢 Add this line
    balance: { type: Number, default: 0 },
    registeredAt: { type: Date, default: Date.now },
    transferInProgress: {
        type: Object,
        default: null, 
    }
});

module.exports = mongoose.model("User", userSchema);
