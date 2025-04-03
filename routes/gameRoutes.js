// routes/gameRoutes.js
const express = require("express");
const User = require("../models/user");
const Game = require("../models/game");
const router = express.Router();

// 1. Start a Game (Create a game session)
router.post("/start", async (req, res) => {
  try {
    const { gameId } = req.body;

    // Check if the game already exists
    const existingGame = await Game.findOne({ gameId });
    if (existingGame) {
      return res.status(400).json({ error: "Game already exists" });
    }

    // Create a new game session
    const newGame = new Game({
      gameId,
      status: "waiting", // Initially, the game is waiting for players
    });

    await newGame.save();

    res.json({ message: "Game started successfully", gameId: newGame.gameId });
  } catch (error) {
    console.error("Error starting game:", error);
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
        console.log("User found:", user);

        // Find the game by gameId
        let game = await Game.findOne({ gameId });

        if (!game) {
            console.log("Game not found, creating new game:", gameId);
            game = new Game({
                gameId,
                status: "waiting", // Initially, the game is waiting for players
                players: [],
            });
            await game.save();
            console.log("Game created successfully:", game);
        } else {
            console.log("Game found:", game);
        }

        // Check if the user has enough balance
        if (user.balance < betAmount) {
            console.log("Insufficient balance. User balance:", user.balance);
            return res.status(400).json({ error: "Insufficient balance" });
        }

        // Deduct the balance
        console.log(`Deducting ${betAmount} from user balance`);
        user.balance -= betAmount;
        await user.save();
        console.log("New user balance:", user.balance);

        // Add the player to the game
        console.log("Adding player to game:", { telegramId, betAmount });
        game.players.push({ telegramId, betAmount });
        await game.save();
        console.log("Player added successfully");

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
