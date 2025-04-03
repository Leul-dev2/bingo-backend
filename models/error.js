const mongoose = require("mongoose");

const errorLogSchema = new mongoose.Schema({
    timestamp: { type: Date, default: Date.now },
    message: String,
    details: String,
});

const ErrorLog = mongoose.model("ErrorLog", errorLogSchema);
module.exports = ErrorLog;
