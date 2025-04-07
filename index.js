const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const http = require("http");            // 👈 For raw HTTP server
const { Server } = require("socket.io"); // 👈 For socket.io
require("dotenv").config();

const userRoutes = require("./routes/userRoutes");
const gameRoutes = require("./routes/gameRoutes");

const app = express();
const server = http.createServer(app); // 👈 Create HTTP server
const io = new Server(server, {
  cors: {
    origin: "https://bossbingo.netlify.app", // Allow all origins — restrict in production
  },
});

// Middleware
app.use(express.json());
app.use(cors());

// Attach io to app to access inside routes
app.set("io", io);

// Routes
app.use("/api/users", userRoutes);
app.use("/api/games", gameRoutes);

// Default route
app.get("/", (req, res) => {
  res.send("MERN Backend with Socket.IO is Running!");
});

// Connect to MongoDB
mongoose
  .connect(process.env.MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(() => console.log("✅ MongoDB Connected"))
  .catch((err) => console.error("❌ MongoDB Connection Error:", err));

// Global error handler
app.use((err, req, res, next) => {
  console.error("🔥 Error Handler:", err.stack);
  res.status(500).json({ message: 'Something went wrong!' });
});

// 🧠 Socket.IO Logic
// In-memory store (optional - for game logic)
const userSelections = {}; // key: telegramId, value: { cardId, card, gameId }

io.on("connection", (socket) => {
  console.log("🟢 New client connected");

  socket.on("joinUser", ({ telegramId }) => {
    socket.join(telegramId);
    console.log(`User ${telegramId} joined personal room`);
    socket.emit("userconnected", { telegramId });
  });

  socket.on("userJoinedGame", ({ telegramId, gameId }) => {
    socket.join(gameId);
    console.log(`User ${telegramId} joined game room: ${gameId}`);
    io.to(telegramId).emit("gameStatusUpdate", "active");
  });

  socket.on("cardSelected", (data) => {
    const { telegramId, cardId, card, gameId } = data;
  
    // Confirm to the sender only
    io.to(telegramId).emit("cardConfirmed", { cardId, card });
  
    // Notify others in the same game room (but not the sender)
    socket.to(gameId).emit("otherCardSelected", {
      telegramId,
      cardId,
    });
  
    console.log(`User ${telegramId} selected card ${cardId} in game ${gameId}`);
  });
  

  socket.on("disconnect", () => {
    console.log("🔴 Client disconnected");
  });
});


// Start the server with WebSocket
const PORT = process.env.PORT || 5002;
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
