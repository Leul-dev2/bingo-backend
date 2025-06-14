const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const http = require("http");
const { Server } = require("socket.io");
require("dotenv").config();

const userRoutes = require("./routes/userRoutes");
const gameRoutes = require("./routes/gameRoutes");
const User = require("./models/user");

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



function resetGame(gameId) {
    console.log(`Resetting game ${gameId}...`);

    // Clear intervals
    clearInterval(drawIntervals[gameId]);
    clearInterval(countdownIntervals[gameId]);

    // Delete game data
    delete gameDraws[gameId];
    delete gameSessions[gameId];
    delete gameCards[gameId];
    delete gameRooms[gameId];
    delete drawIntervals[gameId];
    delete countdownIntervals[gameId];

    console.log(`Game ${gameId} has been fully reset.`);
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

        const numberOfPlayers = gameSessions[gameId]?.length || 0;
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



    socket.on("getPlayerCount", ({ gameId }) => {
       
        const playerCount = gameRooms[gameId]?.length || 0;
        socket.emit("playerCountUpdate", { gameId, playerCount });
    });



    socket.on("gameCount", ({ gameId }) => {
    if (!gameDraws[gameId]) {
       
        resetGame(gameId);

        const numbers = Array.from({ length: 75 }, (_, i) => i + 1).sort(() => Math.random() - 0.5);
        gameDraws[gameId] = { numbers, index: 0 };

        let countdownValue = 5;

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

        }, 1000); // Draws one number every 8 seconds (adjust as needed)
    }

    socket.on("winner", async ({ telegramId, gameId, board, winnerPattern, cartelaId }) => {
        try {
            // ✅ Use gameRooms to track players
            const players = gameRooms[gameId] || [];
            const playerCount = players.length;

            // ✅ Use gameId as stake amount
            const stakeAmount = Number(gameId);  // Change this logic if gameId ≠ stake
            const prizeAmount = stakeAmount * playerCount;

            // ✅ Find the user from the database
            const winnerUser = await User.findOne({ telegramId });
            if (!winnerUser) {
                console.error(`❌ User with telegramId ${telegramId} not found`);
                return;
            }

            // ✅ Find the winner's username (assuming it’s stored as `username`)
            const winnerUsername = winnerUser.username || "Unknown";

            // ✅ Update the user's balance
            winnerUser.balance += prizeAmount;

            // ✅ Save the updated balance
            await winnerUser.save();

            // ✅ Emit the winnerfound event with updated balance info and username
            io.to(gameId.toString()).emit("winnerfound", {
                winnerName: winnerUsername,  // Send username instead of telegramId
                prizeAmount,
                playerCount,
                board,
                winnerPattern,
                boardNumber: cartelaId,
                newBalance: winnerUser.balance, // Optional: return updated balance
                telegramId,
                gameId,
            });

            console.log(`🏆 User ${winnerUsername} (telegramId: ${telegramId}) won and received ${prizeAmount}. New balance: ${winnerUser.balance}`);
            resetGame(gameId);
             io.to(gameId).emit("gameFinished");
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

    // 🧹 Remove player from gameSessions (use Set)
    if (gameSessions[gameId]) {
        gameSessions[gameId].delete(telegramId);
        console.log(`Updated gameSessions for ${gameId}:`, [...gameSessions[gameId]]);
    }

    // 🧹 Remove player from gameRooms (use Set)
    if (gameRooms[gameId]) {
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
    if (
        (!gameRooms[gameId] || gameRooms[gameId].size === 0) &&
        (!gameSessions[gameId] || gameSessions[gameId].size === 0)
    ) {
        console.log(`🧹 No players left in game ${gameId}. Cleaning up memory.`);
        clearInterval(drawIntervals[gameId]);
        clearInterval(countdownIntervals[gameId]);

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
