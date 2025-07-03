const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const http = require("http");
const { Server } = require("socket.io");
require("dotenv").config();

const userRoutes = require("./routes/userRoutes");
const gameRoutes = require("./routes/gameRoutes");
const topPlayers=require('./routes/topPlayers')
const historyRoutes = require('./routes/history');
const walletRoute = require('./routes/wallet');
const profileRoutes = require('./routes/profile');
const PaymentRoute= require ('./routes/paymentRoutes')



const User = require("./models/user");
const GameControl = require("./models/GameControl");
const GameHistory = require('./models/GameHistory');
const { v4: uuidv4 } = require("uuid");


const app = express();
const server = http.createServer(app);


// ⚙️ Setup Socket.IO with CORS
const io = new Server(server, {
  cors: {
    origin: "*", // Change to specific frontend domain in production
    methods: ["GET", "POST"],
  },
});

// 🔐 In-memory shared objects
const gameRooms = {};
const joiningUsers = new Set();

// 📌 Attach shared objects to app for route access
app.set("io", io);
app.set("gameRooms", gameRooms);
app.set("joiningUsers", joiningUsers);
app.set("User", User);

// 🌐 Middleware
app.use(express.json());
app.use(cors());

// 🚏 Routes
app.use("/api/users", userRoutes);
app.use("/api/games", gameRoutes);
app.use("/api/Score", topPlayers); 
app.use('/api/history', historyRoutes);
app.use('/api/wallet', walletRoute);
app.use('/api/profile', profileRoutes);
app.use('.api/payment', PaymentRoute),



// 🏠 Default route
app.get("/", (req, res) => {
  res.send("MERN Backend with Socket.IO is Running!");
});

// 🌍 MongoDB Connection
mongoose
  .connect(process.env.MONGO_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
  })
  .then(() => console.log("✅ MongoDB Connected"))
  .catch((err) => console.error("❌ MongoDB Connection Error:", err));

// 🛑 Global error handler
app.use((err, req, res, next) => {
  console.error("🔥 Error Handler:", err.stack);
  res.status(500).json({ message: "Something went wrong!" });
});


// 🧠 Socket.IO Logic
// In-memory store (optional - for game logic)

let gameSessions = {}; // Store game sessions: gameId -> [telegramId]
let gameSessionIds = {}; 
let userSelections = {}; // Store user selections: socket.id -> { telegramId, gameId }
let gameCards = {}; // Store game card selections: gameId -> { cardId: telegramId }
const gameDraws = {}; // { [gameId]: { numbers: [...], index: 0 } };
const countdownIntervals = {}; // { gameId: intervalId }
const drawIntervals = {}; // { gameId: intervalId }
const activeDrawLocks = {}; // Prevents multiple starts
const gameReadyToStart = {};
let drawStartTimeouts = {};
const gameIsActive = {};
const gamePlayers = {};



    const makeCardAvailable = (gameId, cardId) => {
      if (gameCards[gameId]) {
        delete gameCards[gameId][cardId];  // Remove the card from the selected cards list
        console.log(`Card ${cardId} is now available in game ${gameId}`);
      }
    };



    function resetGame(gameId, io) {
      console.log(`🧹 Starting reset for game ${gameId}`);

      // Clear drawing interval if running
      if (drawIntervals[gameId]) {
        clearInterval(drawIntervals[gameId]);
        delete drawIntervals[gameId];
        console.log(`🛑 Force-cleared draw interval for gameId: ${gameId}`);
      }

      // Clear countdown interval
      if (countdownIntervals[gameId]) {
        clearInterval(countdownIntervals[gameId]);
        delete countdownIntervals[gameId];
      }

      // 🧠 New: clear pending draw start if it exists
      if (drawStartTimeouts[gameId]) {
        clearTimeout(drawStartTimeouts[gameId]);
        delete drawStartTimeouts[gameId];
      }

      // ✅ Remove everything else
      delete activeDrawLocks[gameId];
      delete gameDraws[gameId];
      delete gameCards[gameId];
      gameReadyToStart[gameId] = false; 
      delete gameSessionIds[gameId];
      delete gameSessions[gameId];
      delete gameRooms[gameId];
      delete gameIsActive[gameId];
      delete gamePlayers[gameId];


      // Remove user selections from this game
      for (let socketId in userSelections) {
        if (userSelections[socketId]?.gameId === gameId) {
          delete userSelections[socketId];
        }
      }

      //  manualStartOnly[gameId] = true;
      //  console.log(`🔒 Game ${gameId} is now locked. Awaiting manual start.`);

      console.log(`🧼 Game ${gameId} has been fully reset.`);
    }



io.on("connection", (socket) => {
      console.log("🟢 New client connected");
      console.log("Client connected with socket ID:", socket.id);
      // User joins a game
      socket.on("userJoinedGame", ({ telegramId, gameId }) => {
  // if (!gameRooms[gameId] || !gameRooms[gameId].has(telegramId)) {
  //   console.warn(`🚫 Blocked unpaid user ${telegramId} from joining game session ${gameId}`);
  //   return;
  // }

  if (!gameSessions[gameId]) {
    gameSessions[gameId] = new Set();
  }

  gameSessions[gameId].add(telegramId);
  socket.join(gameId);

  userSelections[socket.id] = { telegramId, gameId };

  // Send current selected cards
  if (gameCards[gameId]) {
    socket.emit("currentCardSelections", gameCards[gameId]);
  }

  // Emit current player count
  const numberOfPlayers = gameSessions[gameId]?.size || 0;
  io.to(gameId).emit("gameid", { gameId, numberOfPlayers });

  console.log(`User ${telegramId} joined game room: ${gameId}`);
      });



     socket.on("cardSelected", (data) => {
      const { telegramId, cardId, card, gameId } = data;

      // ✅ Only allow if user paid (is in gameRooms)
      // if (!gameRooms[gameId] || !gameRooms[gameId].has(telegramId)) {
      //   console.warn(`🚫 Blocked unpaid user ${telegramId} from selecting card in game ${gameId}`);
      //   return;
      // }

      if (!gameCards[gameId]) {
        gameCards[gameId] = {};
      }

      if (gameCards[gameId][cardId] && gameCards[gameId][cardId] !== telegramId) {
        io.to(telegramId).emit("cardUnavailable", { cardId });
        return;
      }

      const prevSelection = userSelections[socket.id];
      const prevCardId = prevSelection?.cardId;

      if (prevCardId && prevCardId !== cardId) {
        delete gameCards[gameId][prevCardId];
        socket.to(gameId).emit("cardAvailable", { cardId: prevCardId });
      }

      gameCards[gameId][cardId] = telegramId;
      userSelections[socket.id] = { telegramId, cardId, card, gameId };

      io.to(telegramId).emit("cardConfirmed", { cardId, card });
      socket.to(gameId).emit("otherCardSelected", { telegramId, cardId });

      const numberOfPlayers = gameSessions[gameId]?.size || 0;
      io.to(gameId).emit("gameid", { gameId, numberOfPlayers });

      console.log(`User ${telegramId} selected card ${cardId} in game ${gameId}`);
    });




        socket.on("joinGame", ({ gameId, telegramId }) => {
      if (!gameRooms[gameId]) gameRooms[gameId] = new Set();
      gameRooms[gameId].add(telegramId);

      socket.join(gameId);

      io.to(gameId).emit("playerCountUpdate", {
          gameId,
          playerCount: gameRooms[gameId].size,
      });

      socket.emit("gameId", { gameId, telegramId });
      });



      // socket.on("getPlayerCount", ({ gameId }) => {
        
      //     const playerCount = gameRooms[gameId]?.length || 0;
      //     socket.emit("playerCountUpdate", { gameId, playerCount });
      // });



    socket.on("gameCount", async ({ gameId }) => {
    // 🚨 PREVENT MULTIPLE INITIALIZATIONS
    if (gameDraws[gameId] || countdownIntervals[gameId] || activeDrawLocks[gameId]) {
      console.log(`⚠️ Game ${gameId} is already preparing or running. Ignoring gameCount event.`);
      return;
    }

    // ✅ Prepare game memory
    gameDraws[gameId] = { numbers: [], index: 0 };

    try {
      const existing = await GameControl.findOne({ gameId });
      const sessionId = uuidv4();
      gameSessionIds[gameId] = sessionId;
      const stakeAmount = Number(gameId); // You can replace with real stake
      const totalCards = gameRooms[gameId]?.size || 0;
      const prizeAmount = stakeAmount * totalCards;

      if (!existing) {
        await GameControl.create({
          sessionId,
          gameId,
          stakeAmount,
          totalCards,
          prizeAmount,
          isActive: false, // ✅ game is NOT active until drawing
          createdBy: "system",
        });
        console.log(`✅ Created GameControl for game ${gameId}`);
      } else {
        existing.sessionId = sessionId;
        existing.stakeAmount = stakeAmount;
        existing.totalCards = totalCards;
        existing.prizeAmount = prizeAmount;
        existing.isActive = false; // ✅ wait for drawing to mark active
        existing.createdAt = new Date();
        await existing.save();
        console.log(`🔄 Updated GameControl for new round of game ${gameId}`);
      }

      // 🎲 Shuffle numbers
      const numbers = Array.from({ length: 75 }, (_, i) => i + 1).sort(() => Math.random() - 0.5);
      gameDraws[gameId].numbers = numbers;

      // ⏱️ Countdown
      let countdownValue = 5;
      countdownIntervals[gameId] = setInterval(async () => {
        if (countdownValue > 0) {
          io.to(gameId).emit("countdownTick", { countdown: countdownValue });
          countdownValue--;
        } else {
          clearInterval(countdownIntervals[gameId]);

          gameCards[gameId] = {};
          io.to(gameId).emit("cardsReset", { gameId });
          io.to(gameId).emit("gameStart");

          gameReadyToStart[gameId] = true;

          // ✅ Now activate the game in memory and DB
          gameIsActive[gameId] = true;
          await GameControl.findOneAndUpdate(
            { gameId },
            { $set: { isActive: true, createdAt: new Date() } }
          );
          console.log(`✅ Game ${gameId} is now ACTIVE. Starting drawing...`);

          if (gameDraws[gameId]) {
            startDrawing(gameId, io);
          } else {
            console.warn(`⛔ Prevented startDrawing: gameDraws missing for game ${gameId}`);
          }
        }
      }, 1000);

    } catch (err) {
      console.error("❌ Error in game setup:", err.message);
      delete gameDraws[gameId];
      delete countdownIntervals[gameId];
      delete gameSessionIds[gameId];
    }
  });



    function startDrawing(gameId, io) {
            console.log(`Starting the drawing process for gameId: ${gameId}`);
            drawIntervals[gameId] = setInterval(() => {
                const game = gameDraws[gameId];

                // Ensure the game and numbers are valid, and index hasn't exceeded the numbers
                if (!game || game.index >= game.numbers.length) {
                    clearInterval(drawIntervals[gameId]);
                    io.to(gameId).emit("allNumbersDrawn");
                    console.log(`All numbers drawn for gameId: ${gameId}`);

                    // Reset the game state when all numbers are drawn
                    delete gameDraws[gameId];
                    return;
                }

                // Draw one number
                const number = game.numbers[game.index++];
                const letterIndex = Math.floor((number - 1) / 15);
                const letter = ["B", "I", "N", "G", "O"][letterIndex];
                const label = `${letter}-${number}`;

                console.log(`Drawing number: ${number}, Label: ${label}, Index: ${game.index - 1}`);

                // Emit the drawn number
                io.to(gameId).emit("numberDrawn", { number, label });

            }, 3000); // Draws one number every 8 seconds (adjust as needed)
        }



socket.on("winner", async ({ telegramId, gameId, board, winnerPattern, cartelaId }) => {
  try {
    const sessionId = gameSessionIds[gameId];
    if (!sessionId) {
      console.error(`❌ No session ID found for gameId ${gameId}`);
      return;
    }

    console.log(`🎯 Processing winner for gameId: ${gameId}, telegramId: ${telegramId}`);

    // Ensure gameId is string to match DB
    const gameData = await GameControl.findOne({ gameId: gameId.toString() });

    if (!gameData) {
      console.error(`❌ GameControl data not found for gameId: ${gameId}`);
      return;
    }

    console.log("🔍 Fetched gameData:", gameData);

    const prizeAmount = gameData.prizeAmount;
    const stakeAmount = gameData.stakeAmount;
    const playerCount = gameData.totalCards;

    if (typeof prizeAmount !== "number" || isNaN(prizeAmount)) {
      console.error(`❌ Invalid or missing prizeAmount (${prizeAmount}) for gameId: ${gameId}`);
      return;
    }

    const winnerUser = await User.findOne({ telegramId });
    if (!winnerUser) {
      console.error(`❌ User with telegramId ${telegramId} not found`);
      return;
    }

    console.log(`🔍 Original winner balance: ${winnerUser.balance}`);

    // Safely update balance
    winnerUser.balance = Number(winnerUser.balance || 0) + prizeAmount;
    await winnerUser.save();

    console.log(`🏆 ${winnerUser.username || "Unknown"} won ${prizeAmount}. New balance: ${winnerUser.balance}`);

    io.to(gameId.toString()).emit("winnerfound", {
      winnerName: winnerUser.username || "Unknown",
      prizeAmount,
      playerCount,
      board,
      winnerPattern,
      boardNumber: cartelaId,
      newBalance: winnerUser.balance,
      telegramId,
      gameId,
    });

    await GameHistory.create({
      sessionId,
      gameId: gameId.toString(),
      username: winnerUser.username || "Unknown",
      telegramId,
      eventType: "win",
      winAmount: prizeAmount,
      stake: stakeAmount,
      createdAt: new Date(),
    });

    const players = gameRooms[gameId] || new Set();
    for (const playerTelegramId of players) {
      if (playerTelegramId !== telegramId) {
        const playerUser = await User.findOne({ telegramId: playerTelegramId });
        if (!playerUser) continue;

        await GameHistory.create({
          sessionId,
          gameId: gameId.toString(),
          username: playerUser.username || "Unknown",
          telegramId: playerTelegramId,
          eventType: "lose",
          winAmount: 0,
          stake: stakeAmount,
          createdAt: new Date(),
        });
      }
    }

    await GameControl.findOneAndUpdate({ gameId: gameId.toString() }, { isActive: false });
    resetGame(gameId);
    io.to(gameId).emit("gameEnded");


  } catch (error) {
    console.error("🔥 Error processing winner:", error);
    socket.emit("winnerError", { message: "Failed to update winner balance. Please try again." });
  }
});





      // Handle disconnection events
   socket.on("disconnect", () => {
      console.log("🔴 Client disconnected");

      const user = userSelections[socket.id];
      if (!user) {
          console.log("❌ No user info found for this socket.");
          return;
      }

      const { telegramId, gameId, cardId } = user;

      // 🃏 Free up the selected card
      if (cardId && gameCards[gameId] && gameCards[gameId][cardId] === telegramId) {
          delete gameCards[gameId][cardId];
          socket.to(gameId).emit("cardAvailable", { cardId });
          console.log(`✅ Card ${cardId} is now available again`);
      }

      // 🧹 Remove player from gameSessions (now a Set)
      if (gameSessions[gameId] instanceof Set) {
          gameSessions[gameId].delete(telegramId);
          console.log(`Updated gameSessions for ${gameId}:`, [...gameSessions[gameId]]);
      }

      // 🧹 Remove player from gameRooms (already a Set)
      if (gameRooms[gameId] instanceof Set) {
          gameRooms[gameId].delete(telegramId);
          console.log(`Updated gameRooms for ${gameId}:`, [...gameRooms[gameId]]);
      }

      // 🧼 Clean userSelections
      delete userSelections[socket.id];

      // 📢 Emit updated player count to the room
      io.to(gameId).emit("playerCountUpdate", {
          gameId,
          playerCount: gameRooms[gameId]?.size || 0,
      });

      io.to(gameId).emit("gameid", {
          gameId,
          numberOfPlayers: gameSessions[gameId]?.size || 0,
      });

      // 🧨 If no players left, clean every
      const currentSessionPlayers = gameSessions[gameId]?.size || 0; // Use a more descriptive variable name
      const currentRoomPlayers = gameRooms[gameId]?.size || 0; // Use a more descriptive variable name

      if (currentSessionPlayers === 0 && currentRoomPlayers === 0) {
          console.log(`🧹 No players left in game ${gameId}. Triggering full game reset.`);
          resetGame(gameId); // Call the dedicated reset function
           io.to(gameId).emit("gameEnded");
      }
  });



  });

// Start the server with WebSocket
const PORT = process.env.PORT || 5002;
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
