const express = require("express");
const router = express.Router();
const User = require("../models/user");
const Game = require("../models/game");
const { Socket } = require("socket.io");

// Error handler helper
const handleError = (res, error, message = "Server Error") => {
  console.error(message, error);
  res.status(500).json({ error: message });
};

// At the top of your file (outside the router), define gameSessions
const userSelections = {}; // key: telegramId, value: { cardId, card, gameId }
const gameSessions = {}; // key: gameId, value: array of telegramIds (players)

io.on("connection", (socket) => {
  console.log("🟢 New client connected");

  socket.on("joinUser", ({ telegramId }) => {
    socket.join(telegramId);
    console.log(`User ${telegramId} joined personal room`);
    socket.emit("userconnected", { telegramId });
  });

  socket.on("userJoinedGame", ({ telegramId, gameId }) => {
    // Add user to the game session
    if (!gameSessions[gameId]) {
      gameSessions[gameId] = [];
    }

    // Avoid duplicates in the game session
    if (!gameSessions[gameId].includes(telegramId)) {
      gameSessions[gameId].push(telegramId);
    }

    socket.join(gameId); // Add the user to the game room
    console.log(`User ${telegramId} joined game room: ${gameId}`);

    // Emit game status to the user
    io.to(telegramId).emit("gameStatusUpdate", "active");

    // Emit the number of players in the game session to all users in that game
    const numberOfPlayers = gameSessions[gameId].length;
    io.to(gameId).emit("gameid", { gameId, numberOfPlayers });

    // Store the gameId in the userSelections object
    if (!userSelections[telegramId]) {
      userSelections[telegramId] = { gameId }; // Initialize if not already set
    } else {
      userSelections[telegramId].gameId = gameId; // Update if already present
    }
  });

  socket.on("cardSelected", (data) => {
    const { telegramId, cardId, card, gameId } = data;

    // Store the selected card in the userSelections object
    userSelections[telegramId] = {
      ...userSelections[telegramId], // preserve existing data
      cardId,
      card,
      gameId, // Store the gameId as well
    };

    // Confirm to the sender only
    io.to(telegramId).emit("cardConfirmed", { cardId, card });

    // Notify others in the same game room (but not the sender)
    socket.to(gameId).emit("otherCardSelected", {
      telegramId,
      cardId,
    });

    console.log(`User ${telegramId} selected card ${cardId} in game ${gameId}`);

    // Emit the number of players in the game session after card selection
    const numberOfPlayers = gameSessions[gameId].length;
    io.to(gameId).emit("gameid", { gameId, numberOfPlayers });
  });

  socket.on("disconnect", () => {
    console.log("🔴 Client disconnected");
  });
});

module.exports = router;
