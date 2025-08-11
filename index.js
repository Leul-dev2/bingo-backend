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













// socket.on("gameCount", async ({ gameId }) => {

//     const strGameId = String(gameId);



//     // --- ⭐ CRITICAL CHANGE 1: Acquire Lock and Check State FIRST ⭐ ---

//     // Check in-memory state for immediate, low-latency lock.

//     if (state.activeDrawLocks[strGameId] || state.countdownIntervals[strGameId] || state.drawIntervals[strGameId] || state.drawStartTimeouts[strGameId]) {

//         console.log(`⚠️ Game ${strGameId} already has an active countdown or draw lock in memory. Ignoring gameCount event.`);

//         return;

//     }



//     // Now check Redis for a persistent lock or active game status (cross-instance safety)

//     const [redisHasLock, redisIsActive] = await Promise.all([

//         redis.get(getActiveDrawLockKey(strGameId)),

//         redis.get(getGameActiveKey(strGameId))

//     ]);



//     if (redisHasLock === "true" || redisIsActive === "true") {

//         console.log(`⚠️ Game ${strGameId} is already active or locked in Redis. Ignoring gameCount event.`);

//         return;

//     }



//     // ⭐ CRITICAL CHANGE 2: Set the lock *immediately after passing all checks* ⭐

//     state.activeDrawLocks[strGameId] = true; // Set in-memory lock

//     await redis.set(getActiveDrawLockKey(strGameId), "true"); // Set Redis lock (with EX/PX if desired for auto-expiry)

//     // You might want to set an expiry on this Redis lock if a game could get stuck

//     // await redis.set(getActiveDrawLockKey(strGameId), "true", 'EX', 300); // e.g., expires in 5 minutes



//     console.log(`🚀 Attempting to start countdown for game ${strGameId}`);



//     try {

//         // --- 1. CLEANUP essential Redis keys and intervals (now that we've acquired the lock and are ready to proceed) ---

//         // This cleanup is valid here, as we're preparing a new countdown.

//         await Promise.all([

//             redis.del(getGameActiveKey(strGameId)),

//             redis.del(getCountdownKey(strGameId)),

//             // redis.del(getActiveDrawLockKey(strGameId)), // Do NOT delete the lock we just acquired!

//             redis.del(getGameDrawStateKey(strGameId)),

//             redis.del(getGameDrawsKey(strGameId)),

//         ]);



//         // Clear any old in-memory intervals if they somehow survived (redundant but safe)

//         if (state.countdownIntervals[strGameId]) {

//             clearInterval(state.countdownIntervals[strGameId]);

//             delete state.countdownIntervals[strGameId];

//         }

//         if (state.drawIntervals[strGameId]) {

//             clearInterval(state.drawIntervals[strGameId]);

//             delete state.drawIntervals[strGameId];

//         }

//         if (state.drawStartTimeouts[strGameId]) {

//             clearTimeout(state.drawStartTimeouts[strGameId]);

//             delete state.drawStartTimeouts[strGameId];

//         }

//         // state.activeDrawLocks[strGameId] is managed by the new logic.



//         // 2. Prepare shuffled numbers and save to Redis under gameDrawStateKey

//         const numbers = Array.from({ length: 75 }, (_, i) => i + 1).sort(() => Math.random() - 0.5);

//         await redis.set(getGameDrawStateKey(strGameId), JSON.stringify({ numbers, index: 0 }));



//         // 3. Create or update GameControl in DB

//         const existing = await GameControl.findOne({ gameId: strGameId });

//         const sessionId = uuidv4();

//         state.gameSessionIds[strGameId] = sessionId; // Using state.gameSessionIds to store sessionId

//         await redis.set(`gameSessionId:${strGameId}`, sessionId, 'EX', 3600 * 24);

//         const stakeAmount = Number(strGameId); // Ideally configurable



//         if (!existing) {

//             await GameControl.create({

//                 sessionId,

//                 gameId: strGameId,

//                 stakeAmount,

//                 totalCards: 0,

//                 prizeAmount: 0,

//                 isActive: false, // Will become true after countdown

//                 createdBy: "system",

//             });

//         } else {

//             existing.sessionId = sessionId;

//             existing.stakeAmount = stakeAmount;

//             existing.totalCards = 0;

//             existing.prizeAmount = 0;

//             existing.isActive = false; // Will become true after countdown

//             existing.createdAt = new Date(); // Update creation time for new session

//             await existing.save();

//         }



//         // 4. Countdown logic via Redis and setInterval

//         let countdownValue = 15;

//         await redis.set(getCountdownKey(strGameId), countdownValue.toString());



//         io.to(strGameId).emit("countdownTick", { countdown: countdownValue }); // Emit initial tick



//         state.countdownIntervals[strGameId] = setInterval(async () => {

//             if (countdownValue > 0) {

//                 countdownValue--;

//                 io.to(strGameId).emit("countdownTick", { countdown: countdownValue });

//                 await redis.set(getCountdownKey(strGameId), countdownValue.toString());

//             } else {

//                 clearInterval(state.countdownIntervals[strGameId]);

//                 delete state.countdownIntervals[strGameId];

//                 await redis.del(getCountdownKey(strGameId));

//                 console.log(`[gameCount] Countdown ended for game ${strGameId}`);



//                 const currentPlayersInRoom = (await redis.sCard(getGameRoomsKey(strGameId))) || 0;

//                 const prizeAmount = stakeAmount * currentPlayersInRoom;



//                 if (currentPlayersInRoom === 0) {

//                     console.log("🛑 No players left in game room after countdown. Stopping game initiation.");

//                     io.to(strGameId).emit("gameNotStarted", {

//                         gameId: strGameId,

//                         message: "Not enough players in game room to start.",

//                     });



//                     // ⭐ CRITICAL CHANGE 3: Release lock and cleanup on no players ⭐

//                     delete state.activeDrawLocks[strGameId]; // Release in-memory lock

//                     await redis.del(getActiveDrawLockKey(strGameId)); // Release Redis lock

//                     await syncGameIsActive(strGameId, false); // Explicitly mark game inactive

//                     await resetRound(strGameId, io, state, redis); // This should now handle gameSessionId cleanup

//                     return; // Exit the setInterval callback

//                 }



//                 // --- CRITICAL RESET FOR GAME START (SESSION-ONLY RESET) ---

//                 await clearGameSessions(strGameId, redis, state, io);

//                 console.log(`🧹 ${getGameSessionsKey(strGameId)} cleared as game started.`);



//                 console.log(`✅ All GameCards for ${strGameId} marked as taken.`);



//                 // Update GameControl DB with active game info

//                 await GameControl.findOneAndUpdate(

//                     { gameId: strGameId },

//                     {

//                         $set: {

//                             isActive: true,

//                             totalCards: currentPlayersInRoom, // Total cards in play is current players

//                             prizeAmount: prizeAmount,

//                             createdAt: new Date(), // Re-set createdAt for the active game start

//                         },

//                     }

//                 );

//                 await syncGameIsActive(strGameId, true); // Sync your in-memory/global active state



//                 console.log(`✅ Game ${strGameId} is now ACTIVE with ${currentPlayersInRoom} players.`);



//                 // Mark game as active in Redis again (to be safe and consistent)

//                 await redis.set(getGameActiveKey(strGameId), "true");

//                 state.gameIsActive[strGameId] = true;

//                 state.gameReadyToStart[strGameId] = true; // Indicate game is ready to start drawin



//                 io.to(strGameId).emit("cardsReset", { gameId: strGameId }); // Inform clients cards are locked/reset

//                 io.to(strGameId).emit("gameStart", { gameId: strGameId }); // Signal clients the game has officially started



//                 // Start drawing numbers if not already running

//                 if (!state.drawIntervals[strGameId]) {

//                     // ⭐ CRITICAL CHANGE 4: Ensure startDrawing also uses the same lock mechanism ⭐

//                     // The startDrawing function also needs to check `state.activeDrawLocks`

//                     // and potentially acquire its own lock if it's a separate phase

//                     await startDrawing(strGameId, io, state, redis); // Pass state and redis if needed

//                 }

//             }

//         }, 1000);

//     } catch (err) {

//         console.error(`❌ Error in gameCount setup for ${gameId}:`, err.message);



//         // --- ⭐ CRITICAL CHANGE 5: Release lock and cleanup on error ⭐

//         delete state.activeDrawLocks[strGameId]; // Release in-memory lock

//         await redis.del(getActiveDrawLockKey(strGameId)); // Release Redis lock

//         await syncGameIsActive(strGameId, false); // Mark game inactive on error



//         // Ensure cleanup on error for initial setup keys

//         delete state.gameDraws[strGameId];

//         delete state.countdownIntervals[strGameId];

//         delete state.gameSessionIds[strGameId]; // ADD THIS: Clear in-memory gameSessionId on error

//         await redis.del(`gameSessionId:${strGameId}`); // ADD THIS: Clear Redis gameSessionId on error



//         await Promise.all([

//             redis.del(getGameDrawsKey(strGameId)),

//             redis.del(getCountdownKey(strGameId)),

//             redis.del(getGameActiveKey(strGameId)),

//             redis.del(getGameDrawStateKey(strGameId)),

//         ]);

//         io.to(strGameId).emit("gameNotStarted", { gameId: strGameId, message: "Error during game setup. Please try again." });

//     }

// });



//  socket.on("joinGame", async ({ gameId, telegramId }) => {

//     console.log("joinGame is invoked 🔥🔥🔥")

//     try {

//         const strGameId = String(gameId);

//         const strTelegramId = String(telegramId);



//         // Validate user is registered in the game via MongoDB

//         const game = await GameControl.findOne({ gameId: strGameId });

//         if (!game || !game.players.includes(strTelegramId)) {

//             console.warn(`🚫 Blocked unpaid user ${strTelegramId} from joining game ${strGameId}`);

//             socket.emit("joinError", { message: "You are not registered in this game." });

//             return;

//         }



//         // Store essential info for disconnect handling for *this* specific phase and socket

//         await redis.hSet(`joinGameSocketsInfo`, socket.id, JSON.stringify({

//             telegramId: strTelegramId,

//             gameId: strGameId,

//             phase: 'joinGame'

//         }));

//         await redis.set(`activeSocket:${strTelegramId}:${socket.id}`, '1', 'EX', ACTIVE_SOCKET_TTL_SECONDS);

//         console.log(`Backend: Socket ${socket.id} for ${strTelegramId} set up in 'joinGame' phase.`);





//         // Add player to Redis set for gameRooms (represents overall game presence)

//         await redis.sAdd(`gameRooms:${strGameId}`, strTelegramId);

//         socket.join(strGameId); // Join the socket.io room



//         const playerCount = await redis.sCard(`gameRooms:${strGameId}`);

//         io.to(strGameId).emit("playerCountUpdate", {

//             gameId: strGameId,

//             playerCount,

//         });

//         console.log(`[joinGame] Player ${strTelegramId} joined game ${strGameId}, total players now: ${playerCount}`);



//         // Confirm to the socket the gameId and telegramId

//         socket.emit("gameId", { gameId: strGameId, telegramId: strTelegramId });



//         // --- NEW LOGIC: Retrieve and send previously drawn numbers ---

//         const gameDrawsKey = getGameDrawsKey(strGameId); // Assuming getGameDrawsKey is available

//         const drawnNumbersRaw = await redis.lRange(gameDrawsKey, 0, -1); // Get all drawn numbers

//         const drawnNumbers = drawnNumbersRaw.map(Number); // Convert them back to numbers if stored as strings



//         // Format the drawn numbers with their letters if needed for client display

//         const formattedDrawnNumbers = drawnNumbers.map(number => {

//             const letterIndex = Math.floor((number - 1) / 15);

//             const letter = ["B", "I", "N", "G", "O"][letterIndex];

//             return { number, label: `${letter}-${number}` };

//         });



//         if (formattedDrawnNumbers.length > 0) {

//             socket.emit("drawnNumbersHistory", {

//                 gameId: strGameId,

//                 history: formattedDrawnNumbers

//             });

//             console.log(`[joinGame] Sent ${formattedDrawnNumbers.length} historical drawn numbers to ${strTelegramId} for game ${strGameId}.`);

//         }

//         // --- END NEW LOGIC ---



//     } catch (err) {

//         console.error("❌ Redis error in joinGame:", err);

//         socket.emit("joinError", { message: "Failed to join game. Please refresh or retry." });

//     }

// });