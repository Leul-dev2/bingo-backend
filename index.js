require("dotenv").config();

// ─── P2: Global error handlers — prevent silent crashes ──────────────────────
process.on("uncaughtException",  (err) => { console.error("💥 uncaughtException:",  err); });
process.on("unhandledRejection", (err) => { console.error("💥 unhandledRejection:", err); });

const express    = require("express");
const cors       = require("cors");
const http       = require("http");
const mongoose   = require("mongoose");
const { Server } = require("socket.io");
const { createClient }  = require("redis");
const { createAdapter } = require("@socket.io/redis-adapter");

const connectDB          = require("./config/db");
const userRoutes         = require("./routes/userRoutes");
const gameRoutes         = require("./routes/gameRoutes");
const topPlayers         = require("./routes/topPlayers");
const historyRoutes      = require("./routes/history");
const walletRoute        = require("./routes/wallet");
const profileRoutes      = require("./routes/profile");
const smsRoutes          = require("./routes/smsWebhook");
const registerGameSocket = require("./sockets/gameSocket");

const GameControl = require("./models/GameControl");
const resetGame   = require("./utils/resetGame");
const { queueUserUpdate, cleanupBatchQueue } = require("./utils/emitBatcher");
const { resetRound } = require("./utils/resetRound");

// ─── App + HTTP server created BEFORE any app.use() calls ────────────────────
const app    = express();
const server = http.createServer(app);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors());

// ─── FIX: Health route registered AFTER app is created ───────────────────────
// Original code called app.use("/health", ...) before `const app = express()`
// which threw "ReferenceError: app is not defined" on startup.
// It is registered here with a lazy Redis/mongoose reference so it is always
// available even before the DB connects (it will report "degraded" until ready).
app.use("/health", require("./routes/health")(
    // Pass lazy getters so the health check always reads the live client objects
    // even though they are assigned later inside the async block below.
    { ping: async () => { if (lazyRedis) return lazyRedis.ping(); throw new Error("Redis not ready"); } },
    mongoose
));

// Lazy reference — assigned once redisClient is connected (see below)
let lazyRedis = null;

const gameState = {};

// ─── Database connection ──────────────────────────────────────────────────────
connectDB();

mongoose.connection.on("connected", async () => {
    console.log("✅ Mongoose connected — applying indexes...");

    await GameControl.createIndexes().catch(err =>
        console.error("❌ Index creation failed:", err)
    );

    const redisUrl = process.env.REDIS_URL || "redis://localhost:6379";
    console.log(`✅ Connecting to Redis at ${redisUrl}...`);

    // ── Redis clients ─────────────────────────────────────────────────────────
    //
    //  pubClient      — used by @socket.io/redis-adapter (publish side)
    //  subClient      — used by @socket.io/redis-adapter (subscribe side)
    //                   Must be a DUPLICATE so it can enter subscribe mode
    //                   without blocking the pub client.
    //
    //  redisClient    — general-purpose commands (get/set/hGet/eval/etc.)
    //                   Passed into all socket handlers and routes.
    //
    //  eventSubscriber — dedicated subscriber for the "game-events" channel
    //                    published by the background worker process.
    //                    Must be a DUPLICATE — a client in subscribe mode
    //                    cannot issue regular commands.
    //
    // NOTE: gameSocket.js previously called redis.duplicate() internally to
    // create its own subClient for ADMIN_COMMANDS.  That is still correct —
    // each subscriber channel needs its own dedicated client.

    const pubClient       = createClient({ url: redisUrl });
    const subClient       = pubClient.duplicate();
    const redisClient     = createClient({ url: redisUrl });
    const eventSubscriber = pubClient.duplicate();

    try {
        await Promise.all([
            pubClient.connect(),
            subClient.connect(),
            redisClient.connect(),
            eventSubscriber.connect(),
        ]);
        console.log("✅ All Redis clients connected.");

        // Expose redisClient to the lazy health-check reference
        lazyRedis = redisClient;

        // ── Socket.io server ──────────────────────────────────────────────────
        const io = new Server(server, {
            cors: {
                origin:  ["http://localhost:5173", "https://frontendbingo.netlify.app"],
                methods: ["GET", "POST"],
            },
            // P1 fix: faster dead-socket detection for Telegram mobile clients
            pingInterval: 10000,
            pingTimeout:  5000,
        });

        // P0 fix: Redis adapter enables io.to(room).emit() across all Node processes.
        // pubClient / subClient are dedicated to the adapter — do NOT use them
        // for regular Redis commands or they will conflict with subscribe mode.
        io.adapter(createAdapter(pubClient, subClient));
        console.log("✅ Socket.IO Redis Adapter attached — horizontal scaling enabled.");

        // ── Worker event subscriber (game-events channel) ─────────────────────
        await eventSubscriber.subscribe("game-events", async (message) => {
    try {
        const data       = JSON.parse(message);
        const strGameId  = String(data.gameId);

        console.log(`[EVENT] '${data.event}' for game: ${strGameId}`);

        switch (data.event) {

            // ── Timer worker → socket server events ───────────────────────────

            case "countdownTick":
                io.to(strGameId).emit("countdownTick", { countdown: data.countdown });
                break;

            case "numberDrawn":
                io.to(strGameId).emit("numberDrawn", {
                    number:           data.number,
                    label:            data.label,
                    callNumberLength: data.callNumberLength,
                });
                break;

            case "gameStart":
                io.to(strGameId).emit("gameStart", { gameId: strGameId });
                break;

            case "gameNotStarted":
                io.to(strGameId).emit("gameNotStarted", { message: data.message });
                break;

            case "batchCardsUpdated":
                io.to(strGameId).emit("batchCardsUpdated", { updates: data.updates });
                break;

            case "gameEnd":
                io.to(strGameId).emit("gameEnd", { gameId: strGameId });
                try {
        // Use the same reset function you already have
           
            await resetRound(strGameId, data.gameSessionId, null, io, gameState, redisClient);
               console.log(`[EVENT] Full reset completed for ended game ${strGameId}`);
            } catch (cleanupErr) {
                console.error(`[EVENT] Cleanup failed after gameEnd for ${strGameId}:`, cleanupErr);
            }
                        break;

            case "gameDetails":
                io.to(strGameId).emit("gameDetails", {
                    winAmount:          data.winAmount,
                    playersCount:       data.playersCount,
                    cardCount:          data.cardCount,
                    stakeAmount:        data.stakeAmount,
                    totalDrawingLength: data.totalDrawingLength,
                    isHouseCutFree:     data.isHouseCutFree,
                });
                break;

            case "gameCardResetOngameStart":
                io.to(strGameId).emit("gameCardResetOngameStart");
                break;

            case "winnerConfirmed":
                io.to(strGameId).emit("winnerConfirmed", data.winnerInfo || {});
                break;

            case "socketsLeave":
                io.in(strGameId).socketsLeave(strGameId);
                break;

            case "checkAndReset": {
                const sessionId = data.gameSessionId || await redisClient.get(`gameSessionId:${strGameId}`);
                if (sessionId) {
                    const remaining = await redisClient.sCard(`gameRooms:${strGameId}`);
                    if (remaining === 0) {
                        console.log(`[checkAndReset] Room empty — resetting game ${strGameId}`);
                        await resetRound(strGameId, sessionId, null, io, gameState, redisClient);
                    }
                }
                break;
            }

            // ── Existing worker events (unchanged) ────────────────────────────

            case "gameReset":
                io.to(strGameId).emit("gameReset", {});
                break;

            case "cardsReleased": {
                const ownerId     = String(data.releasedBy || data.telegramId);
                const releasedIds = Array.isArray(data.cardIds)
                    ? data.cardIds.map(id => Number(id))
                    : [Number(data.cardId || data.cardIds)].filter(id => !isNaN(id));

                if (releasedIds.length > 0) {
                    queueUserUpdate(strGameId, ownerId, [], releasedIds, io, redisClient);
                    console.log(`✅ Batched release of ${releasedIds.length} card(s) by ${ownerId} in game ${strGameId}`);
                }
                break;
            }

            case "fullGameReset":
                cleanupBatchQueue(strGameId);
                resetGame(strGameId, data.gameSessionId, io, gameState, redisClient);
                console.log(`✅ Full reset executed for game ${strGameId}`);
                break;

            default:
                console.warn(`[EVENT] Unhandled event type: ${data.event}`);
        }

    } catch (err) {
        console.error("❌ Error processing game-events message:", err);
    }
});
        console.log("✅ Subscribed to 'game-events' channel.");

        // ── API routes ────────────────────────────────────────────────────────
        app.use("/api/users",   userRoutes(redisClient));
        app.use("/api/games",   gameRoutes(redisClient));
        app.use("/api/Score",   topPlayers);
        app.use("/api/history", historyRoutes);
        app.use("/api/wallet",  walletRoute);
        app.use("/api/profile", profileRoutes);
        app.use("/api",         smsRoutes);

        app.get("/", (req, res) => res.send("Bingo Bot API running 🚀"));

        // ── Socket handlers ───────────────────────────────────────────────────
        // NOTE: gameSocket.js already imports fullGameCleanup and attaches
        // its own Redis adapter — both fixed in the previous patch.
        registerGameSocket(io, redisClient);

        // ── Start HTTP server ─────────────────────────────────────────────────
        const PORT = process.env.PORT || 10000;
        server.listen(PORT, () =>
            console.log(`🚀 Server running on port ${PORT}`)
        );

    } catch (err) {
        console.error("❌ Failed to connect Redis clients:", err);
        process.exit(1); // Hard exit — no point running without Redis
    }
});

mongoose.connection.on("error", (err) => {
    console.error("❌ Mongoose connection error:", err);
});
