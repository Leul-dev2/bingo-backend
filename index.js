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
    // origin: "http://localhost:5173",
  },
});

// Middleware
app.use(express.json());
app.use(cors());
let gameRooms = {};

// Attach io to app to access inside routes
app.set("io", io);
app.set("gameRooms", gameRooms);
// Attach the function to the app object so it's accessible in routes
app.set("emitPlayerCount", emitPlayerCount);

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

let gameSessions = {}; // Store game sessions: gameId -> [telegramId]
let userSelections = {}; // Store user selections: socket.id -> { telegramId, gameId }
let gameCards = {}; // Store game card selections: gameId -> { cardId: telegramId }
const gameDraws = {}; // { [gameId]: { numbers: [...], index: 0 } };



const makeCardAvailable = (gameId, cardId) => {
  if (gameCards[gameId]) {
    delete gameCards[gameId][cardId];  // Remove the card from the selected cards list
    console.log(`Card ${cardId} is now available in game ${gameId}`);
  }
};



function emitPlayerCount(gameId) {
  const playerCount = gameRooms[gameId]?.length || 0;
  io.to(gameId).emit("playerCountUpdate", { gameId, playerCount });
}


io.on("connection", (socket) => {
  console.log("🟢 New client connected");

  // User joins a game
    socket.on("userJoinedGame", ({ telegramId, gameId }) => {
      if (!gameSessions[gameId]) {
        gameSessions[gameId] = [];
      }
    
      if (!gameSessions[gameId].includes(telegramId)) {
        gameSessions[gameId].push(telegramId);
      }
    
      socket.join(gameId);
    
      // 🔁 Store user selection
      userSelections[socket.id] = { telegramId, gameId };
    
      console.log(`User ${telegramId} joined game room: ${gameId}`);
    
      // ✅ Send current selected cards to this user only
      if (gameCards[gameId]) {
        socket.emit("currentCardSelections", gameCards[gameId]);
      }
    
      // ✅ Send player count to all in room
      const numberOfPlayers = gameSessions[gameId].length;
      io.to(gameId).emit("gameid", { gameId, numberOfPlayers });
    });

    

    // socket.on("requestCurrentCards", ({ gameId }) => {
    //   if (!gameCards[gameId]) {
    //     gameCards[gameId] = {};  // Ensure the gameCards object is initialized for the gameId
    //   }
    //   socket.emit("currentCardSelections", gameCards[gameId]);
    // });
    

      socket.on("cardSelected", (data) => {
        const { telegramId, cardId, card, gameId } = data;
      
        if (!gameCards[gameId]) {
          gameCards[gameId] = {}; // initialize if not present
        }
      
        // Check if the card is already taken by another user
        if (gameCards[gameId][cardId] && gameCards[gameId][cardId] !== telegramId) {
          io.to(telegramId).emit("cardUnavailable", { cardId });
          console.log(`Card ${cardId} is already selected by another user`);
          return;
        }
      
        // ✅ Check if the user had selected a card before
        const prevSelection = userSelections[socket.id];
        const prevCardId = prevSelection?.cardId;
      
        // ✅ Free up old card if exists and different from new one
        if (prevCardId && prevCardId !== cardId) {
          delete gameCards[gameId][prevCardId];
          socket.to(gameId).emit("cardAvailable", { cardId: prevCardId });
          console.log(`Card ${prevCardId} is now available again`);
        }
      
        // ✅ Store the new selected card
        gameCards[gameId][cardId] = telegramId;
        userSelections[socket.id] = { telegramId, cardId, card, gameId };

      
        // Confirm to this user
        io.to(telegramId).emit("cardConfirmed", { cardId, card });
      
        // Notify others
        socket.to(gameId).emit("otherCardSelected", { telegramId, cardId });
      
        const numberOfPlayers = gameSessions[gameId]?.length || 0;
        io.to(gameId).emit("gameid", { gameId, numberOfPlayers });
      
        console.log(`User ${telegramId} selected card ${cardId} in game ${gameId}`);

        socket.on("joinGame", (gameId, telegramId) => {
          socket.join(gameId);
          console.log(`Player ${telegramId} joined room ${gameId}`);
      
          // Optionally emit a confirmation back to the joining player
          socket.emit("joinedRoom", {
            message: `You joined game room ${gameId}`,
            telegramId,
          });
      
          // Broadcast updated player count
          // if (gameRooms[gameId]) {
          //   io.to(gameId).emit("playerCountUpdate", {
          //     gameId,
          //     playerCount: gameRooms[gameId].length,
          //   });
          // }
        })
      });

      socket.on("getPlayerCount", ({ gameId }) => {
        socket.join(gameId);  // 👈 Join the room
        const playerCount = gameRooms[gameId]?.length || 0;
        socket.emit("playerCountUpdate", { gameId, playerCount });
      });

      socket.on("gameCount", ({ gameId }) => {
        const numbers = Array.from({ length: 75 }, (_, i) => i + 1).sort(() => Math.random() - 0.5);
        gameDraws[gameId] = { numbers, index: 0 };
        
        io.to(gameId).emit("gameStart", { countdown: 25 });
      
        // Start drawing after 25 seconds
        setTimeout(() => {
          startDrawing(gameId, io);
        }, 25000);
      });
      
      const drawInterval = {};
      
      function startDrawing(gameId, io) {
        console.log(`Starting the drawing process for gameId: ${gameId}`);
        drawInterval[gameId] = setInterval(() => {
          const game = gameDraws[gameId];
      
          // Ensure the game and numbers are valid, and index hasn't exceeded the numbers
          if (!game || game.index >= game.numbers.length) {
            clearInterval(drawInterval[gameId]);
            io.to(gameId).emit("allNumbersDrawn");
            console.log(`All numbers drawn for gameId: ${gameId}`);
            return;
          }
      
          const number = game.numbers[game.index++];
          const letterIndex = Math.floor((number - 1) / 15);
          const letter = ["B", "I", "N", "G", "O"][letterIndex];
          const label = `${letter}-${number}`;
      
          console.log(`Drawing number: ${number}, Label: ${label}, Index: ${game.index - 1}`);
      
          io.to(gameId).emit("numberDrawn", { number, label });
        }, 4000); // Adjust this delay if needed
      }
      

      socket.on("winner", ({ telegramId, gameId, board, winnerPattern, cartelaId }) => {
        const gameRooms = socket.handshake.app.get("gameRooms"); // ⬅ Get gameRooms safely if you're outside route
        const players = gameRooms[gameId] || [];
      
        const playerCount = players.length;
        const stakeAmount = Number(gameId); // assuming gameId = stake
        const prizeAmount = stakeAmount * playerCount;
      
        io.to(gameId).emit("winnerfound", {
          winnerName: telegramId,
          prizeAmount,
          playerCount,
          board,
          winnerPattern,
          boardNumber: cartelaId,
        });
      
        console.log(`Winner declared in game ${gameId}: ${telegramId} wins ${prizeAmount}`);
      });
      
      
      
      
      
  // Handle disconnection event
  socket.on("disconnect", () => {
    console.log("🔴 Client disconnected");
  
    const { telegramId, gameId, cardId } = userSelections[socket.id] || {};
  
    if (telegramId && gameId) {
      // Make card available again
      if (cardId && gameCards[gameId] && gameCards[gameId][cardId] === telegramId) {
        delete gameCards[gameId][cardId];
        socket.to(gameId).emit("cardAvailable", { cardId });
        console.log(`Card ${cardId} is now available again`);
      }
  
      // Remove from gameSessions
      gameSessions[gameId] = gameSessions[gameId]?.filter(id => id !== telegramId);
      console.log(`User ${telegramId} disconnected from game ${gameId}`);
      console.log(`Updated game session ${gameId}:`, gameSessions[gameId]);
  
      // Remove from gameRooms
      if (gameRooms[gameId]) {
        gameRooms[gameId] = gameRooms[gameId].filter(id => id !== telegramId); // ✅ fixed
        console.log(`Updated game room ${gameId}:`, gameRooms[gameId]);
      }
  
      // Clean up userSelections
      delete userSelections[socket.id];
  
      // Emit updated counts
      io.to(gameId).emit("gameid", {
        gameId,
        numberOfPlayers: gameSessions[gameId]?.length || 0,
      });
  
      io.to(gameId).emit("playerCountUpdate", {
        gameId,
        playerCount: gameRooms[gameId]?.length || 0,
      });
    }
  });
  
  
  
});

// Start the server with WebSocket
const PORT = process.env.PORT || 5002;
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
