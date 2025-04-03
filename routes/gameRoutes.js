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
        // Find the user by telegramId
        const user = await User.findOne({ telegramId });
        if (!user) {
            return res.status(404).json({ error: "User not found" });
        }

        // Find the game by gameId
        let game = await Game.findOne({ gameId });

        if (!game) {
            console.log("Game not found. Creating a new game...");
            game = new Game({
                gameId,
                players: [],
                totalPrize: 0,
                gameStatus: "waiting",
            });

            await game.save();
            console.log("Game created:", game);
        }

        // Prevent joining if the game is already active
        if (game.gameStatus === "ongoing") {
            return res.status(400).json({ error: "Game already started" });
        }

        // Check if the user has enough balance
        if (user.balance < betAmount) {
            return res.status(400).json({ error: "Insufficient balance" });
        }

        // Check if player is already in the game
        if (game.players.includes(user._id)) {
            return res.status(400).json({ error: "Player already joined" });
        }

        // Deduct the balance
        user.balance -= betAmount;
        await user.save();

        console.log(`User balance deducted. New balance: ${user.balance}`);

        // Add player to game (store only ObjectId)
        game.players.push(user._id);
        game.totalPrize += betAmount; // Add bet amount to total prize

        console.log(`Players in game:`, game.players);

        // **If less than 2 players, game remains waiting**
        if (game.players.length < 2) {
            await game.save();
            console.log(`Game ${gameId} is waiting for more players.`);
            return res.json({
                message: "Waiting for more players...",
                gameId: game.gameId,
                gameStatus: "waiting",
                players: game.players.length,
                totalPrize: game.totalPrize,
            });
        }

        // **Start the game when 2+ players join**
        game.gameStatus = "ongoing"; 
        await game.save();

        console.log(`Game ${gameId} is now active with ${game.players.length} players.`);

        res.json({
            message: "Joined game successfully",
            newBalance: user.balance,
            gameId: game.gameId,
            gameStatus: game.gameStatus,
            players: game.players.length,
            totalPrize: game.totalPrize,
        });

    } catch (error) {
        console.error("Error joining game:", error);
        res.status(500).json({ error: `Server error: ${error.message}` });
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
