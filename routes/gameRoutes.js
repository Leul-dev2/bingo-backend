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
        console.log("Received request to join game:", { telegramId, gameId, betAmount });

        // Find the user by telegramId
        const user = await User.findOne({ telegramId });
        if (!user) {
            console.log("User not found:", telegramId);
            return res.status(404).json({ error: "User not found" });
        }

        // Find the game by gameId
        let game = await Game.findOne({ gameId });
        if (!game) {
            return res.status(404).json({ error: "Game not found" });
        }

        // Check if the game is already in progress or has already finished
        if (game.status === "in progress" || game.status === "finished") {
            return res.status(400).json({ error: "Game already started or finished" });
        }

        // Check if the game already has two players
        if (game.players.length >= 2) {
            game.status = "in progress"; // Start the game
            await game.save();
            console.log("Game started");
        }

        // Check if the user has enough balance
        if (user.balance < betAmount) {
            console.log("Insufficient balance. User balance:", user.balance);
            return res.status(400).json({ error: "Insufficient balance" });
        }

        // Deduct the balance
        user.balance -= betAmount;
        await user.save();

        // Add the player to the game
        game.players.push({ telegramId, betAmount });
        await game.save();

        // Return success response
        res.json({
            message: "Joined game successfully",
            newBalance: user.balance,
            gameStatus: game.status,
        });
    } catch (error) {
        console.error("Error joining game:", error);
        res.status(500).json({ error: "Server error" });
    }
});


  
      
  

// 3. Get Game Details (Fetch the list of players in the game)
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
