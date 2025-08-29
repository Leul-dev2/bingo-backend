console.log("Mongo URI loaded from environment inside dbjs:", process.env.MONGODB_URI);

const mongoose = require("mongoose");
const mongoUri = process.env.MONGODB_URI;
mongoose.connect(mongoUri, { /* options */ })
    .then(() => console.log("MongoDB connected"))
    .catch(err => console.error("MongoDB connection error:", err));


module.exports = connectDB;
