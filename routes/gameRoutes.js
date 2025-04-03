// routes/gameRoutes.js
const express = require("express");
const User = require("../models/user");
const Game = require("../models/game");
const router = express.Router();

const { v4: uuidv4 } = require('uuid'); // For unique game ID

router.post("/create", async (req, res) => {
    try {
        const gameId = uuidv4(); // Generate a unique game ID
        const newGame = new Game({
            gameId,
            status: "waiting", // Initially, the game is waiting for players
            players: [], // Empty players array initially
        });
        await newGame.save();
        res.json({
            message: "Game created successfully",
            gameId: newGame.gameId,
        });
    } catch (error) {
        console.error("Error creating game:", error);
        res.status(500).json({ error: "Server error" });
    }
});



router.post("/join", async (req, res) => {
    const { telegramId, gameId, betAmount } = req.body;
  
    try {
      const user = await User.findOne({ telegramId });
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }
  
      let game = await Game.findOne({ gameId });
      if (!game) {
        game = new Game({
          gameId,
          gameStatus: "waiting",
          players: [],
          createdAt: new Date(),
        });
        await game.save();
      }
  
      if (game.gameStatus === "active") {
        return res.status(400).json({ error: "Game already started" });
      }
  
      if (user.balance < betAmount) {
        return res.status(400).json({ error: "Insufficient balance" });
      }
  
      if (game.players.some(player => player.telegramId === telegramId)) {
        return res.status(400).json({ error: "Player already joined" });
      }
  
      user.balance -= betAmount;
      await user.save();
  
      game.players.push({ telegramId, betAmount });
  
      // Start the 15-second countdown when the first player joins
      if (game.players.length === 1) {
        game.timerStart = new Date(); // Set the start time for the timer
        await game.save();
      }
  
      await game.save();
  
      res.json({
        message: "Joined game successfully",
        newBalance: user.balance,
        gameId: game.gameId,
        gameStatus: game.gameStatus,
        players: game.players.length,
      });
    } catch (error) {
      console.error("Error in /join:", error);
      res.status(500).json({ error: "Server error" });
    }
  });





router.get("/status", async (req, res) => {
    const { gameId } = req.query;

    if (!gameId) {
        return res.status(400).json({ error: "Game ID is required" });
    }

    try {
        const game = await Game.findOne({ gameId });
        if (!game) return res.status(404).json({ error: "Game not found" });

        res.json({ gameStatus: game.status, players: game.players.length });
    } catch (error) {
        console.error("Error checking game status:", error);
        res.status(500).json({ error: "Server error" });
    }
});




//3. Get Game Details (Fetch the list of players in the game)
router.get("/details/:gameId", async (req, res) => {
  const { gameId } = req.params;

  try {
    const game = await Game.findOne({ gameId });
    if (!game) {
      return res.status(404).json({ error: "Game not found" });
    }

    res.json({
      gameId: game.gameId,
      players: game.players,
      status: game.status,
      startTime: game.startTime,
    });
  } catch (error) {
    console.error("Error fetching game details:", error);
    res.status(500).json({ error: "Server error" });
  }
});

module.exports = router;
