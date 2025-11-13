require("dotenv").config();

console.log("Mongo URI loaded from environment index:", process.env.MONGODB_URI);

const express = require("express");
const cors = require("cors");
const http = require("http");
const mongoose = require("mongoose");
const { Server } = require("socket.io");
const { createClient } = require("redis"); // 1. Import createClient

const connectDB = require("./config/db");
const userRoutes = require("./routes/userRoutes");
const gameRoutes = require("./routes/gameRoutes");
const topPlayers = require('./routes/topPlayers');
const historyRoutes = require('./routes/history');
const walletRoute = require('./routes/wallet');
const profileRoutes = require('./routes/profile');
const registerGameSocket = require("./sockets/gameSocket");
const paymentRoutes = require("./routes/paymentRoutes");
const smsRoutes = require("./routes/smsWebhook");

const User = require("./models/user");
const GameControl = require("./models/GameControl");
const GameHistory = require('./models/GameHistory');

// 2. Create the Redis Client
const redisClient = createClient({
    // Make sure REDIS_URL is in your .env file
    url: process.env.REDIS_URL 
});
redisClient.on('error', err => console.error('❌ Redis Client Error', err));


const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] },
    pingInterval: 15000,
    pingTimeout: 25000,
});

// 🌐 Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 3. Fix: Configure CORS for Express
// (Remove any other app.use(cors()) lines)
app.use(cors({
    origin: ['http://localhost:5173', 
        'https://frontendbingo.netlify.app'] // Add your production URL
}));

// 📌 Routes
app.use("/api/users", userRoutes);
app.use("/api/games", gameRoutes(redisClient)); // 4. Pass redisClient
app.use("/api/Score", topPlayers);
app.use('/api/history', historyRoutes);
app.use('/api/wallet', walletRoute);
app.use('/api/profile', profileRoutes);
app.use("/api/payment", paymentRoutes);
app.use("/api", smsRoutes);

// ✅ Default Route
app.get("/", (req, res) => res.send("Bingo Bot API running 🚀"));

// 🧠 Register sockets
registerGameSocket(io, redisClient); // 5. Pass redisClient

// 🌍 MongoDB Connection
connectDB();

// 6. Start server only after DB and Redis connect
mongoose.connection.on('connected', async () => { // Make this async
    console.log('✅ Mongoose connection successful, applying indexes...');

    try {
        // 7. Connect to Redis *before* starting the server
        await redisClient.connect();
        console.log('✅ Redis client connected successfully.');
    } catch (err) {
        console.error('❌ Failed to connect to Redis:', err);
        process.exit(1); // Stop if Redis fails to connect
    }

    // Force Mongoose to create all indexes...
    GameControl.createIndexes()
        .then(() => console.log('✅ GameControl indexes created successfully.'))
        .catch(err => console.error('❌ Index creation failed:', err));

    // 🚀 Start server
    const PORT = process.env.PORT || 5002;
    server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
});

// If there's an error connecting to the database
mongoose.connection.on('error', (err) => {
    console.error('❌ Mongoose connection error:', err);
});