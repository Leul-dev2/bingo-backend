require("dotenv").config();

console.log("Mongo URI loaded from environment:", process.env.MONGO_URI);

const express = require("express");
const cors = require("cors");
const http = require("http");
const mongoose = require("mongoose");
const { Server } = require("socket.io");


const connectDB = require("./config/db");
const userRoutes = require("./routes/userRoutes");
const gameRoutes = require("./routes/gameRoutes");
const topPlayers=require('./routes/topPlayers')
const historyRoutes = require('./routes/history');
const walletRoute = require('./routes/wallet');
const profileRoutes = require('./routes/profile');
const registerGameSocket = require("./sockets/gameSocket")
const paymentRoutes = require("./routes/paymentRoutes"); // or wherever your file is
const smsRoutes = require("./routes/smsWebhook");


const User = require("./models/user");
const GameControl = require("./models/GameControl");
const GameHistory = require('./models/GameHistory');



const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] },
    // --- ADD THESE LINES TO CONFIGURE PING-PONG ---
    pingInterval: 2000, // Server sends a ping every 5 seconds
    pingTimeout: 2000,  // Server waits 3 seconds for a pong response
    // ------------------------------------------------
});

// 🌐 Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors());

// 📌 Routes
app.use("/api/users", userRoutes);
app.use("/api/games", gameRoutes);
app.use("/api/Score", topPlayers); 
app.use('/api/history', historyRoutes);
app.use('/api/wallet', walletRoute);
app.use('/api/profile', profileRoutes);
app.use("/api/payment", paymentRoutes);
app.use("/api", smsRoutes);



// ✅ Default Route
app.get("/", (req, res) => res.send("Bingo Bot API running 🚀"));

// 🧠 Register sockets
registerGameSocket(io);

// 🌍 MongoDB Connection
connectDB();

// ⭐ CRITICAL UPDATE: Ensure indexes are created after connection is established ⭐
mongoose.connection.on('connected', () => {
    console.log('✅ Mongoose connection successful, applying indexes...');

    // Force Mongoose to create all indexes from your schema.
    // This is idempotent, so it is safe to run on every startup.
    GameControl.createIndexes()
        .then(() => console.log('✅ GameControl indexes created successfully.'))
        .catch(err => console.error('❌ Index creation failed:', err));

    // 🚀 Start server
    const PORT = process.env.PORT || 5002;
    server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
});

// If there's an error connecting to the database, the app shouldn't start.
mongoose.connection.on('error', (err) => {
    console.error('❌ Mongoose connection error:', err);
});

