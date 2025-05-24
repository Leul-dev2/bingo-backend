const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const http = require("http");            // 👈 For raw HTTP server
const { Server } = require("socket.io"); // 👈 For socket.io
require("dotenv").config();


const userRoutes = require("./routes/userRoutes");
const gameRoutes = require("./routes/gameRoutes");
const User = require("./models/user");
const Game = require("./models/game");
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
const countdownIntervals = {}; // { gameId: intervalId }
const drawIntervals = {}; // { gameId: intervalId }



const makeCardAvailable = (gameId, cardId) => {
  if (gameCards[gameId]) {
    delete gameCards[gameId][cardId];  // Remove the card from the selected cards list
    console.log(`Card ${cardId} is now available in game ${gameId}`);
  }
};



async function resetGame(gameId) {
  console.log(`Resetting game ${gameId}...`);

  clearInterval(drawIntervals[gameId]);
  clearInterval(countdownIntervals[gameId]);

  delete gameDraws[gameId];
  delete gameCards[gameId];
  delete gameRooms[gameId];
  delete drawIntervals[gameId];
  delete countdownIntervals[gameId];

  // Reset game document
  await Game.findOneAndUpdate(
    { gameId },
    {
      players: [],
      winners: [],
      prizePool: 0,
      status: "active",
      startedAt: new Date(),
      endedAt: null,
    }
  );

  // Confirm
  const updated = await Game.findOne({ gameId });
  console.log("✅ After reset, game players:", updated.players); // Should be []

  console.log(`Game ${gameId} has been fully reset.`);
}



app.set("resetGame", resetGame);


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

        // // Initialize gameRooms if it doesn't exist
        // if (!gameRooms[gameId]) {
        //     gameRooms[gameId] = [];
        // }

        // // Add the player to the gameRooms
        // if (!gameRooms[gameId].includes(telegramId)) {
        //     gameRooms[gameId].push(telegramId);
        // }

        // // Emit the updated player count
        // io.to(gameId).emit("playerCountUpdate", { gameId, playerCount: gameRooms[gameId].length });


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

        const numberOfPlayers = gameSessions[gameId]?.length || 0;
        io.to(gameId).emit("gameid", { gameId, numberOfPlayers });

        console.log(`User ${telegramId} selected card ${cardId} in game ${gameId}`);

    });


   

    socket.on("joinGame", ({ gameId, telegramId }) => {
        socket.join(gameId);

        // Send back only to this player their data
        socket.emit("gameId", { gameId, telegramId });

        // You can store socket.telegramId = telegramId if needed
    });

    socket.on("getPlayerCount", ({ gameId }) => {
        socket.join(gameId);  // 👈 Join the room
        const playerCount = gameRooms[gameId]?.length || 0;
        socket.emit("playerCountUpdate", { gameId, playerCount });
    });

    socket.on("gameCount", ({ gameId }) => {
    if (!gameDraws[gameId]) {
        const numbers = Array.from({ length: 75 }, (_, i) => i + 1).sort(() => Math.random() - 0.5);
        gameDraws[gameId] = { numbers, index: 0 };

        let countdownValue = 15;

        // Broadcast the countdown every second
        countdownIntervals[gameId] = setInterval(() => {
            if (countdownValue > 0) {
                io.to(gameId).emit("countdownTick", { countdown: countdownValue });
                countdownValue--;
            } else {
                clearInterval(countdownIntervals[gameId]);
                // ✅ Notify frontend to start the game
                io.to(gameId).emit("gameStart");
                  gameCards[gameId] = {};
                  io.to(gameId).emit("cardsReset", { gameId });

                // 🎯 Begin drawing
                startDrawing(gameId, io);
            }
        }, 1000);
    } else {
        console.log(`Game ${gameId} already initialized. Ignoring gameCount event.`);
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
    const resetGame = socket.request.app.get("resetGame");
    const gameRooms = socket.request.app.get("gameRooms") || {};
    const players = gameRooms[gameId] || [];
    const playerCount = players.length;
    const stakeAmount = 0; // update this as needed
    const prizeAmount = stakeAmount * playerCount;

    const existingGame = await Game.findOne({ gameId });
    if (!existingGame) return socket.emit("winnerError", { message: "Game not found" });
    if (existingGame.status === "completed") return socket.emit("winnerError", { message: "Game already completed" });

    const updatedWinners = [];

    const user = await User.findOneAndUpdate(
      { telegramId },
      { $inc: { balance: prizeAmount } },
      { new: true }
    );

    if (user) {
      updatedWinners.push({
        telegramId,
        username: user.username,
        newBalance: user.balance
      });
    }

    const updatedGame = await Game.findOneAndUpdate(
      { gameId },
      {
        winners: [telegramId],
        playerCount,
        prizeAmount,
        winnerPattern,
        cartelaId,
        board,
        status: "completed",
        endedAt: new Date(),
        players: [],
      },
      { new: true }
    );

    io.to(gameId.toString()).emit("winnerfound", {
      winnerName: user.username,
      prizeAmount: updatedGame.prizeAmount,
      playerCount: updatedGame.playerCount,
      board,
      winnerPattern,
      boardNumber: cartelaId,
      newBalance: user.balance,
      telegramId,
      gameId,
    });

    if (typeof resetGame === "function") {
      resetGame(gameId);
    }

    io.to(gameId).emit("gameFinished");

    console.log(`🏆 Winner handled directly via socket. Game ${gameId} completed.`);
  } catch (error) {
    console.error("🔥 Error handling winner via socket:", error.message);
    socket.emit("winnerError", { message: "Failed to complete game. Try again." });
  }
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
                gameRooms[gameId] = gameRooms[gameId].filter(id => id !== telegramId);
                console.log(`Updated game room ${gameId}:`, gameRooms[gameId]);

                if (gameRooms[gameId].length === 0) {
                    resetGame(gameId);  // ✅ use the same function
                } else {
                    io.to(gameId).emit("playerCountUpdate", {
                        gameId,
                        playerCount: gameRooms[gameId].length
                    });
                }
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
