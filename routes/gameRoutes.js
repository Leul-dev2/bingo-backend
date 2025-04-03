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
        console.log(`Received request: telegramId=${telegramId}, gameId=${gameId}, betAmount=${betAmount}`);

        // Find the user by telegramId
        const user = await User.findOne({ telegramId });
        if (!user) {
            console.log("User not found:", telegramId);
            return res.status(404).json({ error: "User not found" });
        }

        // Find the game by gameId
        let game = await Game.findOne({ gameId });

        if (!game) {
            console.log(`Game ${gameId} not found. Creating a new one...`);

            // Create a new game
            game = new Game({
                gameId, 
                gameStatus: "waiting",
                players: [],
                createdAt: new Date(),
            });

            await game.save(); 
            console.log("Game created:", game);
        }

        // Prevent joining if the game is already active
        if (game.gameStatus === "active") {
            console.log(`Game ${gameId} is already active. Rejecting request.`);
            return res.status(400).json({ error: "Game already started" });
        }

        // Check if user has enough balance
        if (user.balance < betAmount) {
            console.log(`User ${telegramId} has insufficient balance.`);
            return res.status(400).json({ error: "Insufficient balance" });
        }

        // Check if player is already in the game
        if (game.players.some(player => player.telegramId === telegramId)) {
            console.log(`User ${telegramId} is already in game ${gameId}`);
            return res.status(400).json({ error: "Player already joined" });
        }

        // Deduct the balance
        user.balance -= betAmount;
        await user.save();
        console.log(`User ${telegramId} balance deducted. New balance: ${user.balance}`);

        // Add player to game
        game.players.push({ telegramId, betAmount });

        // **Start the 15-second countdown if first player**
        if (game.players.length === 1) {
            console.log(`First player joined. Starting 15-second timer for game ${gameId}...`);

            setTimeout(async () => {
                try {
                    // Fetch the game again inside the timer
                    let updatedGame = await Game.findOne({ gameId });

                    if (updatedGame && updatedGame.gameStatus === "waiting") {
                        updatedGame.gameStatus = "active"; // Start the game
                        await updatedGame.save();
                        console.log(`Game ${gameId} started automatically after 15 seconds.`);
                    } else {
                        console.log(`Game ${gameId} was already active or deleted before the timer finished.`);
                    }
                } catch (error) {
                    console.error("Error inside setTimeout function:", error);
                }
            }, 15000); // 15 seconds
        }

        await game.save();
        console.log(`User ${telegramId} successfully joined game ${gameId}`);

        res.json({
            message: "Joined game successfully",
            newBalance: user.balance,
            gameId: game.gameId,
            gameStatus: game.gameStatus,
            players: game.players.length,
        });

    } catch (error) {
        console.error("Server error during /join:", error);
        res.status(500).json({ error: "Server error", details: error.message });
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
