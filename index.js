require("dotenv").config();

// ─── Env var validation — fail fast with clear error ─────────────────────────
const REQUIRED_ENV = ["REDIS_URL", "MONGODB_URI", "TELEGRAM_BOT_TOKEN"];
for (const key of REQUIRED_ENV) {
    if (!process.env[key]) {
        console.error(`❌ Missing required environment variable: ${key}`);
        process.exit(1);
    }
}

// ─── Global error handlers — prevent silent crashes ───────────────────────────
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

// ─── App + HTTP server ────────────────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors());

// ─── Health route ─────────────────────────────────────────────────────────────
app.use("/health", require("./routes/health")(
    { ping: async () => { if (lazyRedis) return lazyRedis.ping(); throw new Error("Redis not ready"); } },
    mongoose
));

// ─── Module-scope references for graceful shutdown ────────────────────────────
let lazyRedis       = null;
let pubClient       = null;
let subClient       = null;
let redisClient     = null;
let eventSubscriber = null;

const gameState = {};

// ─── Database connection ──────────────────────────────────────────────────────
connectDB();

mongoose.connection.on("connected", async () => {
    console.log("✅ Mongoose connected — applying indexes...");

    await GameControl.createIndexes().catch(err =>
        console.error("❌ Index creation failed:", err)
    );

    const redisUrl = process.env.REDIS_URL;
    console.log(`✅ Connecting to Redis...`);

    const redisOptions = {
        url: redisUrl,
        socket: {
            tls:               redisUrl.startsWith("rediss://"),
            reconnectStrategy: (retries) => Math.min(retries * 200, 3000),
            keepAlive:         30000,
        },
    };

    // Assign to module-scope variables so gracefulShutdown can access them
    pubClient       = createClient(redisOptions);
    subClient       = pubClient.duplicate();
    redisClient     = createClient(redisOptions);
    eventSubscriber = pubClient.duplicate();

    try {
        await Promise.all([
            pubClient.connect(),
            subClient.connect(),
            redisClient.connect(),
            eventSubscriber.connect(),
        ]);
        console.log("✅ All Redis clients connected.");

        lazyRedis = redisClient;

        // ── Socket.IO server ──────────────────────────────────────────────────
        const io = new Server(server, {
            cors: {
                origin: process.env.NODE_ENV === "production"
                    ? ["https://frontendbingo.netlify.app"]
                    : ["http://localhost:5173", "https://frontendbingo.netlify.app"],
                methods: ["GET", "POST"],
            },
            pingInterval: 10000,
            pingTimeout:  5000,
        });

        io.adapter(createAdapter(pubClient, subClient));
        console.log("✅ Socket.IO Redis Adapter attached — horizontal scaling enabled.");

        // ── game-events subscriber ────────────────────────────────────────────
        await eventSubscriber.subscribe("game-events", async (message) => {
            try {
                const data      = JSON.parse(message);
                const strGameId = String(data.gameId);

                console.log(`[EVENT] '${data.event}' for game: ${strGameId}`);

                switch (data.event) {

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

                    case "playerCountUpdate":
                        io.to(strGameId).emit("playerCountUpdate", {
                            gameId:      strGameId,
                            playerCount: data.playerCount,
                        });
                        break;

                    case "checkAndReset": {
                        const sessionId = data.gameSessionId || await redisClient.get(`gameSessionId:${strGameId}`);
                        if (sessionId) {
                            const [roomCount, sessionCount] = await Promise.all([
                                redisClient.sCard(`gameRooms:${strGameId}`),
                                redisClient.sCard(`gameSessions:${strGameId}`),
                            ]);
                            if (roomCount === 0 && sessionCount === 0) {
                                console.log(`[checkAndReset] Both sets empty — resetting game ${strGameId}`);
                                await resetRound(strGameId, sessionId, null, io, gameState, redisClient);
                            } else {
                                console.log(`[checkAndReset] Players still present — gameRooms: ${roomCount}, gameSessions: ${sessionCount}`);
                            }
                        }
                        break;
                    }

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
                        try {
                            cleanupBatchQueue(strGameId);
                            await resetGame(strGameId, data.gameSessionId, io, gameState, redisClient);
                            console.log(`✅ Full reset executed for game ${strGameId}`);
                        } catch (err) {
                            console.error(`❌ fullGameReset failed for game ${strGameId}:`, err);
                        }
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
        registerGameSocket(io, redisClient);

        // ── Start HTTP server ─────────────────────────────────────────────────
        const PORT = process.env.PORT || 10000;
        server.listen(PORT, () =>
            console.log(`🚀 Server running on port ${PORT}`)
        );

    } catch (err) {
        console.error("❌ Failed to connect Redis clients:", err);
        process.exit(1);
    }
});

mongoose.connection.on("error", (err) => {
    console.error("❌ Mongoose connection error:", err);
});

// ─── Graceful shutdown ────────────────────────────────────────────────────────
async function gracefulShutdown(signal) {
    console.log(`[index] ${signal} — shutting down gracefully`);
    server.close(async () => {
        await Promise.all([
            pubClient?.quit().catch(() => {}),
            redisClient?.quit().catch(() => {}),
            eventSubscriber?.quit().catch(() => {}),
        ]);
        await mongoose.connection.close().catch(() => {});
        console.log("[index] All connections closed");
        process.exit(0);
    });
    setTimeout(() => {
        console.error("[index] Graceful shutdown timed out — forcing exit");
        process.exit(1);
    }, 15000);
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT",  () => gracefulShutdown("SIGINT"));
