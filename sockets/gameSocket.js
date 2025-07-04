const User = require("../models/user");
const GameControl = require("../models/GameControl");
const resetGame = require("../utils/resetGame");

module.exports = function registerGameSocket(io) {
  const gameRooms = {};
  const gameDraws = {};
  const userSelections = {};
  const countdownIntervals = {};
  const drawIntervals = {};
  const gameSessions = {};
  const gameIsActive = {};

  io.on("connection", (socket) => {
    console.log("🟢 Client connected:", socket.id);

    socket.on("userJoinedGame", ({ telegramId, gameId }) => {
      if (!gameRooms[gameId]) gameRooms[gameId] = new Set();
      gameRooms[gameId].add(telegramId);
      socket.join(gameId);
      userSelections[socket.id] = { telegramId, gameId };

      io.to(gameId).emit("playerCountUpdate", {
        gameId,
        playerCount: gameRooms[gameId].size,
      });
    });

    socket.on("gameCount", async ({ gameId }) => {
      gameDraws[gameId] = {
        numbers: Array.from({ length: 75 }, (_, i) => i + 1).sort(() => Math.random() - 0.5),
        index: 0,
      };

      let countdown = 5;
      countdownIntervals[gameId] = setInterval(async () => {
        if (countdown > 0) {
          io.to(gameId).emit("countdownTick", { countdown });
          countdown--;
        } else {
          clearInterval(countdownIntervals[gameId]);
          io.to(gameId).emit("gameStart");

          drawIntervals[gameId] = setInterval(() => {
            const game = gameDraws[gameId];
            if (game.index >= game.numbers.length) {
              clearInterval(drawIntervals[gameId]);
              return;
            }
            const number = game.numbers[game.index++];
            io.to(gameId).emit("numberDrawn", { number });
          }, 3000);
        }
      }, 1000);
    });

    socket.on("cardSelected", ({ telegramId, cardId, gameId }) => {
      if (!userSelections[socket.id]) return;
      userSelections[socket.id].cardId = cardId;
      io.to(gameId).emit("cardConfirmed", { telegramId, cardId });
    });

    socket.on("winner", async ({ telegramId, gameId }) => {
      try {
        const user = await User.findOne({ telegramId });
        if (user) {
          user.balance += 1000; // Replace with actual prize logic
          await user.save();

          io.to(gameId).emit("winnerfound", {
            telegramId,
            newBalance: user.balance,
          });
        }
        await GameControl.findOneAndUpdate({ gameId }, { isActive: false });
        resetGame(gameId, io, {
          drawIntervals,
          countdownIntervals,
          gameDraws,
          gameRooms,
          userSelections,
          gameSessions,
          gameIsActive,
        });
      } catch (err) {
        console.error("❌ Winner error:", err.message);
      }
    });

    socket.on("disconnect", () => {
      const user = userSelections[socket.id];
      if (user) {
        const { telegramId, gameId } = user;
        gameRooms[gameId]?.delete(telegramId);
        delete userSelections[socket.id];

        io.to(gameId).emit("playerCountUpdate", {
          gameId,
          playerCount: gameRooms[gameId]?.size || 0,
        });
      }
    });
  });
};
