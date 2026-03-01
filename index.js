require("dotenv").config();

const express = require("express");
const cors = require("cors");
const http = require("http");
const mongoose = require("mongoose");
const { Server } = require("socket.io");
const { createClient } = require("redis");
const { createAdapter } = require("@socket.io/redis-adapter");

const connectDB = require("./config/db");
const userRoutes = require("./routes/userRoutes");
const gameRoutes = require("./routes/gameRoutes");
const topPlayers = require('./routes/topPlayers');
const historyRoutes = require('./routes/history');
const walletRoute = require('./routes/wallet');
const profileRoutes = require('./routes/profile');
const registerGameSocket = require("./sockets/gameSocket");
const smsRoutes = require("./routes/smsWebhook");
const GameControl = require("./models/GameControl");
const resetGame = require("./utils/resetGame");

const gameState = {}; 

const app = express();
const server = http.createServer(app);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors());

connectDB();

mongoose.connection.on('connected', async () => {
    console.log('✅ Mongoose connection successful, applying indexes...');
    await GameControl.createIndexes().catch(err => console.error('❌ Index creation failed:', err));


    // Client for Pub/Sub - exclusively for Socket.IO adapter
    const pubClient = createClient({ url: redisUrl });
    const subClient = pubClient.duplicate();

    const redisClient = createClient({
            url: process.env.REDIS_URL // Ensure this is set in Render Dashboard
    });

    // New client to subscribe to events published by the worker process
    const eventSubscriber = pubClient.duplicate();

    try {
        await Promise.all([
            pubClient.connect(),
            subClient.connect(),
            redisClient.connect(),
            eventSubscriber.connect()
        ]);
        console.log("✅ Redis Pub/Sub, Command, and Event clients connected successfully.");

        const io = new Server(server, {
                cors: { origin: ["http://localhost:5173", "https://frontendbingo.netlify.app"], methods: ["GET", "POST"] },
                pingInterval: 15000,
                pingTimeout: 15000,
            });
        io.adapter(createAdapter(pubClient, subClient));
        console.log("✅ Socket.IO Redis Adapter applied for horizontal scaling.");

        // --- 🟢 NEW: Worker Event Handler via Redis Pub/Sub ---
        // This is how the web server receives instructions from the worker.
     await eventSubscriber.subscribe('game-events', (message) => {
        try {
            const data = JSON.parse(message);
            console.log(`[EVENT] Received '${data.event}' event for game: ${data.gameId}`);

            if (data.event === 'gameReset') {
                // Your existing logic for simple cleanup/notification
                io.to(data.gameId).emit('gameReset', { /* ... */ });
                
            } else if (data.event === 'cardReleased') { // ⬅️ NEW BLOCK FOR CARD RELEASE
             const strGameId = String(data.gameId);
            
                 io.to(strGameId).emit("cardReleased", {
                    cardId: data.cardId,
                    telegramId: data.releasedBy // Optional: good for logging/debugging on the client
                });
            
         console.log(`✅ Emitted 'cardReleased' for card ${data.cardId} in Game ${data.gameId}.`); 
                    
        }else if (data.event === 'fullGameReset') { // <--- 3. CATCH THE WORKER'S SIGNAL
                
                //// Execute the function signature you provided: resetGame(gameId, strGameSessionId, io, state, redis)
                resetGame(data.gameId, data.gameSessionId, io, gameState, redisClient); 
                
                console.log(`✅ Executed local resetGame for Game ${data.gameId} triggered by worker.`);

            }
        } catch (err) {
            console.error("❌ Error processing message from game-events channel:", err);
        }
        });
        console.log("✅ Subscribed to 'game-events' channel for worker communication.");
        // --------------------------------------------------------

        app.use("/api/users", userRoutes(redisClient));
        app.use("/api/games", gameRoutes(redisClient));
        app.use("/api/Score", topPlayers);
        app.use('/api/history', historyRoutes);
        app.use('/api/wallet', walletRoute);
        app.use('/api/profile', profileRoutes);
        app.use("/api", smsRoutes);

        app.get("/", (req, res) => res.send("Bingo Bot API running 🚀"));

        registerGameSocket(io, redisClient);

        const PORT = process.env.PORT || 5002;
        server.listen(PORT, () => console.log(`Server running on port ${PORT}`));

    } catch (err) {
        console.error("❌ Failed to connect Redis clients:", err);
    }
});

mongoose.connection.on('error', (err) => {
    console.error('❌ Mongoose connection error:', err);
});

