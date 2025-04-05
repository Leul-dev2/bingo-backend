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
io.on("connection", (socket) => {
  console.log("🟢 New client connected");

  // Join user room
  socket.on("joinUser", ({ telegramId }) => {
    socket.join(telegramId);
    console.log(`User ${telegramId} joined personal room`);
  });

  // Join game room
  socket.on("userJoinedGame", ({ telegramId, gameId }) => {
    socket.join(gameId);
    console.log(`User ${telegramId} joined game room: ${gameId}`);
    io.to(gameId).emit("gameStatusUpdate", "ongoing");
  });

  socket.on("disconnect", () => {
    console.log("🔴 Client disconnected");
  });
});

// Start the server with WebSocket
const PORT = process.env.PORT || 5005;
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
