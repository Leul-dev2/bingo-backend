const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
require("dotenv").config();

const app = express();
const userRoutes = require("./routes/userRoutes");
const gameRoutes = require("./routes/gameRoutes");  // Import game-related routes

// Middleware
app.use(express.json());
app.use(cors());

// Routes
app.use("/api/users", userRoutes);
app.use("/api/games", gameRoutes);  // Game routes

// Default route
app.get("/", (req, res) => {
  res.send("MERN Backend is Running!");
});

// Connect to MongoDB
mongoose
  .connect(process.env.MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(() => console.log("MongoDB Connected"))
  .catch((err) => console.log(err));

// Global error handler
app.use((err, req, res, next) => {
  console.error(err.stack);  // Log the error in the server
  res.status(500).json({ message: 'Something went wrong!' });
});

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
