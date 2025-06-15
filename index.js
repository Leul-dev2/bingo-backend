const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const http = require("http");
const { Server } = require("socket.io");
require("dotenv").config();

const userRoutes = require("./routes/userRoutes");
const gameRoutes = require("./routes/gameRoutes");
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



const makeCardAvailable = (gameId, cardId) => {
  if (gameCards[gameId]) {
    delete gameCards[gameId][cardId];  // Remove the card from the selected cards list
    console.log(`Card ${cardId} is now available in game ${gameId}`);
  }
};



  function resetGame(gameId, io) {
      console.log(`🔄 Resetting game ${gameId}...`);

      // 1. Free up selected cards and clean userSelections
      for (const socketId in userSelections) {
          const user = userSelections[socketId];
          if (user?.gameId === gameId) {
              const { telegramId, cardId } = user;

              // 🃏 Free up the card
              if (cardId && gameCards[gameId]?.[cardId] === telegramId) {
                  delete gameCards[gameId][cardId];
                  io.to(gameId).emit("cardAvailable", { cardId });
                  console.log(`✅ Card ${cardId} is now available again`);
              }

              // 🧹 Clean userSelections
              delete userSelections[socketId];
          }
      }

      // 3. Clear intervals
      clearInterval(drawIntervals[gameId]);
      clearInterval(countdownIntervals[gameId]);
      delete activeDrawLocks[gameId];

      // 4. Delete all game data
      delete gameDraws[gameId];
      delete gameSessions[gameId];
      delete gameCards[gameId];
      delete gameRooms[gameId];
      delete drawIntervals[gameId];
      delete countdownIntervals[gameId];

      console.log(`🧼 Game ${gameId} has been fully reset.`);
  }




  io.on("connection", (socket) => {
    console.log("🟢 New client connected");
    console.log("Client connected with socket ID:", socket.id);
    // User joins a game
    socket.on("userJoinedGame", ({ telegramId, gameId }) => {
        if (!gameSessions[gameId]) {
         gameSessions[gameId] = new Set();
       }

     gameSessions[gameId].add(telegramId); // Set automatically prevents duplicates
 

        socket.join(gameId);

        // 🔁 Store user selection
        userSelections[socket.id] = { telegramId, gameId };

        console.log(`User ${telegramId} joined game room: ${gameId}`);

        // ✅ Send current selected cards to this user only
        if (gameCards[gameId]) {
            socket.emit("currentCardSelections", gameCards[gameId]);
        }

       
        // ✅ Send player count to all in room
        const numberOfPlayers = gameSessions[gameId]?.size || 0;
         console.log(`Emitting player count ${numberOfPlayers} for game ${gameId}`);
        io.to(gameId).emit("gameid", { gameId, numberOfPlayers });
    });


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
  if (!gameDraws[gameId]) {
    try {
      const existing = await GameControl.findOne({ gameId });
      const sessionId = uuidv4();
      gameSessionIds[gameId] = sessionId;
      const stakeAmount = Number(gameId);
      const totalCards = Object.keys(gameCards[gameId] || {}).length;

      if (!existing) {
        await GameControl.create({
          sessionId: sessionId, 
          gameId,
          stakeAmount,
          totalCards,
          isActive: true,
          createdBy: "system",
        });
        console.log(`✅ Created GameControl for game ${gameId}`);
      } else {
        existing.stakeAmount = stakeAmount;
        existing.totalCards = totalCards;
        existing.isActive = true;
        existing.createdAt = new Date();
        await existing.save();
        console.log(`🔄 Updated GameControl for new round of game ${gameId}`);
      }

      // ✅ Store GameHistory
      await GameHistory.create({
        sessionId, // Unique session per round
        gameId: gameId.toString(),
        username: "system",           // optional, since no winner yet
        telegramId: "system",         // optional
        winAmount: 0,                 // no winner yet
        stake: stakeAmount,
        createdAt: new Date()
      });
      console.log(`📜 GameHistory created for game ${gameId}`);

    } catch (err) {
      console.error("❌ Error in GameControl or GameHistory:", err.message);
    }

    // Step 2: Shuffle numbers
    const numbers = Array.from({ length: 75 }, (_, i) => i + 1).sort(() => Math.random() - 0.5);
    gameDraws[gameId] = { numbers, index: 0 };

    // Step 3: Countdown
    let countdownValue = 5;

    countdownIntervals[gameId] = setInterval(() => {
      if (countdownValue > 0) {
        io.to(gameId).emit("countdownTick", { countdown: countdownValue });
        countdownValue--;
      } else {
        clearInterval(countdownIntervals[gameId]);

        io.to(gameId).emit("gameStart");

        gameCards[gameId] = {};
        io.to(gameId).emit("cardsReset", { gameId });

        startDrawing(gameId, io);
      }
    }, 1000);
  } else {
    console.log(`Game ${gameId} already initialized. Ignoring gameCount event.`);
  }
});





    function startDrawing(gameId, io) {
    // 🛑 Prevent duplicate drawing intervals
    if (activeDrawLocks[gameId]) {
        console.log(`⚠️ Drawing already in progress for gameId: ${gameId}`);
        return;
    }

    console.log(`🎯 Starting the drawing process for gameId: ${gameId}`);
    activeDrawLocks[gameId] = true;

    drawIntervals[gameId] = setInterval(() => {
        const game = gameDraws[gameId];

        // ❌ Invalid game or finished drawing
        if (!game || game.index >= game.numbers.length) {
            clearInterval(drawIntervals[gameId]);
            delete drawIntervals[gameId];
            delete activeDrawLocks[gameId];

            io.to(gameId).emit("allNumbersDrawn");
            console.log(`✅ All numbers drawn for gameId: ${gameId}`);

            // Reset game state
            delete gameDraws[gameId];
            return;
        }

        // ✅ Draw one number
        const number = game.numbers[game.index++];
        const letterIndex = Math.floor((number - 1) / 15);
        const letter = ["B", "I", "N", "G", "O"][letterIndex];
        const label = `${letter}-${number}`;

        console.log(`🎲 Drawing number: ${number}, Label: ${label}, Index: ${game.index - 1}`);

        io.to(gameId).emit("numberDrawn", { number, label });

    }, 3000); // Adjust interval as needed
}

    socket.on("winner", async ({ telegramId, gameId, board, winnerPattern, cartelaId }) => {
        try {
          const sessionId = gameSessionIds[gameId];
          const players = gameRooms[gameId] || new Set();
          const playerCount = players.size;
          const stakeAmount = Number(gameId);
          const prizeAmount = stakeAmount * playerCount;

          const winnerUser = await User.findOne({ telegramId });
          if (!winnerUser) {
            console.error(`❌ User with telegramId ${telegramId} not found`);
            return;
          }

          const winnerUsername = winnerUser.username || "Unknown";
          winnerUser.balance += prizeAmount;
          await winnerUser.save();

          // Emit winner found event
          io.to(gameId.toString()).emit("winnerfound", {
            winnerName: winnerUsername,
            prizeAmount,
            playerCount,
            board,
            winnerPattern,
            boardNumber: cartelaId,
            newBalance: winnerUser.balance,
            telegramId,
            gameId,
          });

          console.log(`🏆 ${winnerUsername} won ${prizeAmount}. New balance: ${winnerUser.balance}`);

          // Save winner details to GameHistory
          await GameHistory.findOneAndUpdate(
              { sessionId },
          { // optional: link to session if you have it
            gameId: gameId.toString(),
            username: winnerUsername,
            telegramId,
            winAmount: prizeAmount,
            stake: stakeAmount,
            createdAt: new Date()
          }
          );

          // Final cleanup
          await GameControl.findOneAndUpdate({ gameId }, { isActive: false });
          resetGame(gameId);

        } catch (error) {
          console.error("🔥 Error processing winner:", error);
          socket.emit("winnerError", { message: "Failed to update winner balance. Please try again." });
        }
  });





    // Handle disconnection event
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

    // 🧨 If no players left, clean everything
    const sessionsEmpty = !gameSessions[gameId] || gameSessions[gameId].size === 0;
    const roomsEmpty = !gameRooms[gameId] || gameRooms[gameId].size === 0;

    if (sessionsEmpty && roomsEmpty) {
        console.log(`🧹 No players left in game ${gameId}. Cleaning up memory.`);
        clearInterval(drawIntervals[gameId]);
        clearInterval(countdownIntervals[gameId]);
        delete activeDrawLocks[gameId];

        delete gameDraws[gameId];
        delete drawIntervals[gameId];
        delete countdownIntervals[gameId];
        delete gameCards[gameId];
        delete gameSessions[gameId];
        delete gameRooms[gameId];
    }
});



});

// Start the server with WebSocket
const PORT = process.env.PORT || 5002;
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
