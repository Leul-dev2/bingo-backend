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


// --- Global State Objects ---
// These objects hold the current state of your games in memory.
// Declared outside `io.on` so they are accessible across all connections.
const drawIntervals = {};      // Stores setInterval IDs for active drawing processes.
const countdownIntervals = {}; // Stores setInterval IDs for active countdowns.
const drawStartTimeouts = {};  // Stores setTimeout IDs for pending draw starts.
const activeDrawLocks = {};    // Flags to prevent multiple concurrent draw processes per game.
const gameDraws = {};          // { gameId: { numbers: [], index: 0 } } - Shuffled numbers and current index for each game.
const gameCards = {};          // { gameId: { cardId: telegramId } } - Tracks selected cards by game.
const userSelections = {};     // { socketId: { telegramId, cardId, card, gameId } } - Tracks individual user's selections.
const gameSessionIds = {};     // { gameId: sessionId } - Stores the unique session ID for the *current* round of a game.

// --- Consolidated Player Tracking ---
const gamePlayers = {};        // { gameId: Set<telegramId> } - Replaces gameSessions and gameRooms for consistent player tracking.

// --- Game State Management ---
// Crucial for managing the lifecycle of each game and preventing race conditions.
const gameStates = {};         // { gameId: "IDLE" | "COUNTDOWN" | "DRAWING" | "FINISHED" | "RESETTING" }

// --- Utility Function: Full Game Reset ---
// This is the SINGLE authoritative function for clearing a game's state.
function resetGame(gameId, ioInstance) {
  console.log(`🧹 Starting full reset for game ${gameId}`);
  // Immediately set state to prevent any new actions during cleanup
  gameStates[gameId] = "RESETTING";

  // Clear any existing drawing interval
  if (drawIntervals[gameId]) {
    clearInterval(drawIntervals[gameId]);
    delete drawIntervals[gameId];
    console.log(`🛑 Cleared draw interval for gameId: ${gameId}`);
  }

  // Clear any existing countdown interval
  if (countdownIntervals[gameId]) {
    clearInterval(countdownIntervals[gameId]);
    delete countdownIntervals[gameId];
    console.log(`🛑 Cleared countdown interval for gameId: ${gameId}`);
  }

  // Clear any pending draw start timeout
  if (drawStartTimeouts[gameId]) {
    clearTimeout(drawStartTimeouts[gameId]);
    delete drawStartTimeouts[gameId];
    console.log(`🛑 Cleared draw start timeout for gameId: ${gameId}`);
  }

  // Remove all game-specific data from memory
  delete activeDrawLocks[gameId];
  delete gameDraws[gameId];
  delete gameCards[gameId];
  delete gamePlayers[gameId]; // Clear the consolidated player set
  delete gameSessionIds[gameId]; // Clean up the session ID for the previous round

  // Remove user selections associated with this specific game
  // Iterate through userSelections and delete entries related to the `gameId` being reset.
  for (const socketId in userSelections) {
    if (userSelections[socketId]?.gameId === gameId) {
      delete userSelections[socketId];
    }
  }

  // After all cleanup, mark the game as IDLE, ready for a new round
  gameStates[gameId] = "IDLE";
  console.log(`🧼 Game ${gameId} has been fully reset. Current state: ${gameStates[gameId]}`);
}

// --- Utility Function: Start Drawing Process ---
function startDrawing(gameId, ioInstance) {
  // Centralized state check: Prevent drawing if already active or resetting
  if (gameStates[gameId] === "DRAWING" || gameStates[gameId] === "COUNTDOWN" || gameStates[gameId] === "RESETTING") {
    console.log(`⚠️ Drawing already in progress, starting soon, or resetting for gameId: ${gameId}. Current state: ${gameStates[gameId]}`);
    return;
  }

  // Ensure gameDraws is properly initialized before proceeding
  if (!gameDraws[gameId] || !gameDraws[gameId].numbers || gameDraws[gameId].numbers.length === 0) {
    console.log(`⛔ Game ${gameId} drawing data not initialized properly. Cannot start drawing.`);
    gameStates[gameId] = "IDLE"; // Reset to idle if data is truly missing
    return;
  }

  // Set state to indicate drawing is about to begin
  gameStates[gameId] = "COUNTDOWN"; // Or "PREPARING_DRAW" depending on your exact flow
  console.log(`🎯 Preparing to start drawing for gameId: ${gameId}. Current state: ${gameStates[gameId]}`);

  // Set a timeout to actually start the drawing after a short delay
  drawStartTimeouts[gameId] = setTimeout(() => {
    delete drawStartTimeouts[gameId]; // Clean up the timeout reference once it's triggered

    const game = gameDraws[gameId];

    // This check handles cases where game data might have been cleared unexpectedly
    if (!game || game.index >= game.numbers.length) {
      console.log(`⚠️ Attempted to start a finished or invalid game: ${gameId}. Game data missing or complete.`);
      resetGame(gameId, ioInstance); // Force reset if in a bad state
      return;
    }

    console.log(`🎯 Starting the drawing process for gameId: ${gameId}`);
    activeDrawLocks[gameId] = true; // Set a lock to prevent concurrent starts
    gameStates[gameId] = "DRAWING"; // Set state to DRAWING

    drawIntervals[gameId] = setInterval(() => {
      const game = gameDraws[gameId];

      // If no more numbers or game state is invalid, stop drawing
      if (!game || game.index >= game.numbers.length) {
        clearInterval(drawIntervals[gameId]);
        delete drawIntervals[gameId];
        delete activeDrawLocks[gameId];

        ioInstance.to(gameId).emit("allNumbersDrawn");
        console.log(`✅ All numbers drawn for gameId: ${gameId}`);
        gameStates[gameId] = "FINISHED"; // Mark as finished

        // Add a small delay before full reset to allow clients to process "allNumbersDrawn"
        setTimeout(() => resetGame(gameId, ioInstance), 1000); // 1-second delay
        return;
      }

      const number = game.numbers[game.index++];
      const label = ["B", "I", "N", "G", "O"][Math.floor((number - 1) / 15)] + "-" + number;
      console.log(`🎲 Drawing number: ${number}, Label: ${label}, Index: ${game.index - 1}`);
      ioInstance.to(gameId).emit("numberDrawn", { number, label });
    }, 3000); // Draw a new number every 3 seconds
  }, 1000); // Initial 1-second delay before drawing starts
}

// --- Utility Function: Initialize/Prepare a New Game Round ---
// This function should be called explicitly when a new game round is desired
// (e.g., by an admin client, or automatically after a game ends).
async function initNewGameRound(gameId, ioInstance) {
  // Always perform a full reset first to ensure a clean slate for the new round
  resetGame(gameId, ioInstance);

  // Set initial state for the new round
  gameStates[gameId] = "WAITING_FOR_PLAYERS";
  console.log(`✨ Initializing new round for game ${gameId}. Current state: ${gameStates[gameId]}`);

  // Step 1: Manage GameControl and GameHistory (database operations)
  try {
    const sessionId = uuidv4();
    gameSessionIds[gameId] = sessionId; // Store the new session ID for the round
    const stakeAmount = Number(gameId); // Assuming gameId IS the stake amount

    // `totalCards` might be 0 initially and updated later if card selection happens after this point
    const totalCards = Object.keys(gameCards[gameId] || {}).length;

    const existingControl = await GameControl.findOne({ gameId });

    if (!existingControl) {
      await GameControl.create({
        sessionId: sessionId,
        gameId,
        stakeAmount,
        totalCards,
        isActive: true,
        createdBy: "system",
      });
      console.log(`✅ Created GameControl record for game ${gameId}`);
    } else {
      // If a GameControl record exists, update it for the new round
      existingControl.sessionId = sessionId;
      existingControl.stakeAmount = stakeAmount;
      existingControl.totalCards = totalCards;
      existingControl.isActive = true;
      existingControl.createdAt = new Date(); // Update timestamp for the new round
      await existingControl.save();
      console.log(`🔄 Updated GameControl for new round of game ${gameId}`);
    }

    // Create a new GameHistory entry for this specific round
    await GameHistory.create({
      sessionId, // Unique session ID for this round
      gameId: gameId.toString(),
      username: "system", // Initial: no winner yet
      telegramId: "system", // Initial
      winAmount: 0,
      stake: stakeAmount,
      createdAt: new Date(),
    });
    console.log(`📜 GameHistory created for game ${gameId} session ${sessionId}`);

  } catch (err) {
    console.error("❌ Error setting up GameControl or GameHistory:", err.message);
    gameStates[gameId] = "ERROR"; // Indicate an error state
    return; // Prevent further game setup if DB operation fails
  }

  // Step 2: Shuffle numbers for the new game round
  const numbers = Array.from({ length: 75 }, (_, i) => i + 1).sort(() => Math.random() - 0.5);
  gameDraws[gameId] = { numbers, index: 0 };
  console.log(`🃏 Game ${gameId} numbers shuffled.`);

  // Reset selected cards for the new round (important for a fresh game)
  gameCards[gameId] = {};
  ioInstance.to(gameId).emit("cardsReset", { gameId });
  console.log(`🔄 Game ${gameId} cards reset for new round.`);

  // Step 3: Initiate the countdown
  let countdownValue = 5;
  gameStates[gameId] = "COUNTDOWN"; // Set game state for countdown
  ioInstance.to(gameId).emit("countdownTick", { countdown: countdownValue }); // Send initial tick

  countdownIntervals[gameId] = setInterval(() => {
    if (countdownValue > 0) {
      ioInstance.to(gameId).emit("countdownTick", { countdown: countdownValue });
      countdownValue--;
    } else {
      clearInterval(countdownIntervals[gameId]);
      delete countdownIntervals[gameId]; // Clean up interval reference
      console.log(`⏳ Countdown finished for game ${gameId}.`);

      ioInstance.to(gameId).emit("gameStart"); // Signal game start to clients

      // Once countdown is done, explicitly start drawing
      startDrawing(gameId, ioInstance);
    }
  }, 1000); // Tick every second
}


// --- Socket.IO Connection Handler ---
io.on("connection", (socket) => {
  console.log("🟢 New client connected");
  console.log("Client connected with socket ID:", socket.id);

  // --- userJoinedGame: When a user initially joins a game room ---
  socket.on("userJoinedGame", ({ telegramId, gameId }) => {
    // Initialize gamePlayers set if it doesn't exist for this gameId
    if (!gamePlayers[gameId]) {
      gamePlayers[gameId] = new Set();
      // If this is the first player, ensure game state is initialized to IDLE
      if (!gameStates[gameId]) {
        gameStates[gameId] = "IDLE";
      }
    }
    gamePlayers[gameId].add(telegramId); // Add player to the consolidated set

    socket.join(gameId); // Join Socket.IO room

    // Store user selection (telegramId and gameId are essential for disconnect handling)
    userSelections[socket.id] = { telegramId, gameId };

    console.log(`User ${telegramId} joined game room: ${gameId}`);

    // Send current selected cards to this user only (for observing occupied cards)
    if (gameCards[gameId]) {
      socket.emit("currentCardSelections", gameCards[gameId]);
    }

    // Send player count to all in room
    const numberOfPlayers = gamePlayers[gameId]?.size || 0;
    console.log(`Emitting player count ${numberOfPlayers} for game ${gameId}`);
    io.to(gameId).emit("gameid", { gameId, numberOfPlayers }); // "gameid" is used for player count
  });

  // --- cardSelected: When a user selects or changes their chosen card ---
  socket.on("cardSelected", (data) => {
    const { telegramId, cardId, card, gameId } = data;

    // Ensure gameCards exists for this game (should be initialized by initNewGameRound)
    if (!gameCards[gameId]) {
      gameCards[gameId] = {};
    }

    // Check if the card is already taken by another user
    if (gameCards[gameId][cardId] && gameCards[gameId][cardId] !== telegramId) {
      socket.emit("cardUnavailable", { cardId }); // Emit to the specific user's socket
      console.log(`Card ${cardId} is already selected by another user`);
      return;
    }

    // Check for previous selection by this user
    const prevSelection = userSelections[socket.id];
    const prevCardId = prevSelection?.cardId;

    // Free up the old card if the user selected a different one
    if (prevCardId && prevCardId !== cardId) {
      delete gameCards[gameId][prevCardId];
      socket.to(gameId).emit("cardAvailable", { cardId: prevCardId }); // Notify others
      console.log(`Card ${prevCardId} is now available again`);
    }

    // Store the new selected card and update user's overall selection
    gameCards[gameId][cardId] = telegramId;
    userSelections[socket.id] = { telegramId, cardId, card, gameId };

    // Confirm selection to the user who made it
    socket.emit("cardConfirmed", { cardId, card });

    // Notify others in the room about the new selection
    socket.to(gameId).emit("otherCardSelected", { telegramId, cardId });

    // Update player count (only needed if card selection signifies a "player joining" stage)
    const numberOfPlayers = gamePlayers[gameId]?.size || 0;
    io.to(gameId).emit("gameid", { gameId, numberOfPlayers });

    console.log(`User ${telegramId} selected card ${cardId} in game ${gameId}`);
  });

  // --- gameCount: This event triggers the start of a new game round ---
  // This should be emitted by an admin client or a system process when a new game round should begin.
  socket.on("gameCount", async ({ gameId }) => {
    // Prevent starting a new game if one is already active (drawing, countdown, or resetting)
    if (gameStates[gameId] === "DRAWING" || gameStates[gameId] === "COUNTDOWN" || gameStates[gameId] === "RESETTING") {
      console.log(`Game ${gameId} is already active or resetting. Ignoring gameCount event. Current state: ${gameStates[gameId]}`);
      socket.emit("gameStartFailed", { gameId, message: "Game already in progress or resetting." });
      return;
    }

    console.log(`Attempting to start/restart game ${gameId} via gameCount event.`);
    // Call the dedicated initialization function for a new game round
    await initNewGameRound(gameId, io);
  });

  // --- winner: When a player declares bingo! ---
  socket.on("winner", async ({ telegramId, gameId, board, winnerPattern, cartelaId }) => {
    try {
      // IMPORTANT: Stop the current drawing immediately if a winner is found
      if (gameStates[gameId] === "DRAWING") {
        console.log(`🏆 Winner found for game ${gameId}! Stopping drawing.`);
        // Force clear all drawing related intervals/timeouts/locks
        clearInterval(drawIntervals[gameId]);
        delete drawIntervals[gameId];
        clearTimeout(drawStartTimeouts[gameId]);
        delete drawStartTimeouts[gameId];
        delete activeDrawLocks[gameId];
        gameStates[gameId] = "FINISHED"; // Immediately mark game as finished
      } else {
        console.log(`🏆 Winner found for game ${gameId}, but drawing was not active. Current state: ${gameStates[gameId]}`);
      }

      const sessionId = gameSessionIds[gameId]; // Get the session ID for the current round
      if (!sessionId) {
        console.error(`❌ No active session ID found for game ${gameId} for winner processing.`);
        socket.emit("winnerError", { message: "No active game session." });
        return;
      }

      const players = gamePlayers[gameId] || new Set(); // Use the consolidated player set
      const playerCount = players.size;
      const stakeAmount = Number(gameId); // Assuming gameId represents stake
      const prizeAmount = stakeAmount * playerCount;

      const winnerUser = await User.findOne({ telegramId });
      if (!winnerUser) {
        console.error(`❌ User with telegramId ${telegramId} not found`);
        socket.emit("winnerError", { message: "Winner user not found in database." });
        return;
      }

      const winnerUsername = winnerUser.username || "Unknown";
      winnerUser.balance += prizeAmount; // Update winner's balance
      await winnerUser.save();

      // Emit winner found event to all clients in the game room
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

      // Update the GameHistory record for this session with winner details
      await GameHistory.findOneAndUpdate(
        { sessionId, gameId: gameId.toString() }, // Query by both session and game ID for precision
        {
          username: winnerUsername,
          telegramId,
          winAmount: prizeAmount,
        },
        { upsert: false } // Do not create a new record if not found; it should exist from initNewGameRound
      );
      console.log(`📜 GameHistory updated for game ${gameId} session ${sessionId} with winner.`);

      // Update GameControl to mark the game as inactive for this specific session
      await GameControl.findOneAndUpdate({ gameId, sessionId }, { isActive: false });

      // After a short delay, reset the game state completely to prepare for a new round
      // This delay allows clients to display the winner information before everything is cleared.
      setTimeout(() => resetGame(gameId, io), 2000); // 2-second delay for client display
    } catch (error) {
      console.error("🔥 Error processing winner:", error);
      socket.emit("winnerError", { message: "Failed to process winner. Please try again." });
    }
  });

  // --- disconnect: When a client disconnects from the server ---
  socket.on("disconnect", () => {
    console.log("🔴 Client disconnected");

    const user = userSelections[socket.id];
    if (!user) {
      console.log("❌ No user info found for this socket.");
      return; // Exit if no user data for this socket
    }

    const { telegramId, gameId, cardId } = user;

    // Free up the selected card if this user had one
    if (cardId && gameCards[gameId] && gameCards[gameId][cardId] === telegramId) {
      delete gameCards[gameId][cardId];
      // Notify others in the room that this card is now available
      socket.to(gameId).emit("cardAvailable", { cardId });
      console.log(`✅ Card ${cardId} is now available again due to disconnect.`);
    }

    // Remove the disconnected player from the consolidated gamePlayers set
    if (gamePlayers[gameId] instanceof Set) {
      gamePlayers[gameId].delete(telegramId);
      console.log(`Updated gamePlayers for ${gameId}:`, [...gamePlayers[gameId]]);
    }

    // Clean up this socket's entry in userSelections
    delete userSelections[socket.id];

    // Emit updated player count to the room
    const currentPlayersInGame = gamePlayers[gameId]?.size || 0;
    io.to(gameId).emit("playerCountUpdate", { gameId, playerCount: currentPlayersInGame });
    io.to(gameId).emit("gameid", { gameId, numberOfPlayers: currentPlayersInGame }); // Using "gameid" for player count

    // If no players are left in this specific game, trigger a full reset of that game's state
    if (currentPlayersInGame === 0) {
      console.log(`🧹 No players left in game ${gameId}. Triggering full cleanup.`);
      resetGame(gameId, io); // Use the consistent reset function
    }
  });
});

// --- Start the server ---
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});