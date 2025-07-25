const express = require("express");
const cors = require("cors");
const http = require("http");
const mongoose = require("mongoose");
const { Server } = require("socket.io");
require("dotenv").config();

const connectDB = require("./config/db");
const userRoutes = require("./routes/userRoutes");
const gameRoutes = require("./routes/gameRoutes");
const topPlayers=require('./routes/topPlayers')
const historyRoutes = require('./routes/history');
const walletRoute = require('./routes/wallet');
const profileRoutes = require('./routes/profile');
const registerGameSocket = require("./sockets/gameSocket")
const paymentRoutes = require("./routes/paymentRoutes"); // or wherever your file is


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
app.use(cors());

// 📌 Routes
app.use("/api/users", userRoutes);
app.use("/api/games", gameRoutes);
app.use("/api/Score", topPlayers); 
app.use('/api/history', historyRoutes);
app.use('/api/wallet', walletRoute);
app.use('/api/profile', profileRoutes);
app.use("/api/payment", paymentRoutes);



// ✅ Default Route
app.get("/", (req, res) => res.send("Bingo Bot API running 🚀"));

// 🧠 Register sockets
registerGameSocket(io);

// 🌍 MongoDB Connection
connectDB();

// 🚀 Start server
const PORT = process.env.PORT || 5002;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
