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



const gameTimers = {}; // Store countdown timers for each game
const countdownValues = {}; // Store remaining countdown time

router.post("/join", async (req, res) => {
    const { telegramId, gameId, betAmount } = req.body;

    try {
        // Find user
        const user = await User.findOne({ telegramId });
        if (!user) {
            return res.status(404).json({ error: "User not found" });
        }

        // Find game
        let game = await Game.findOne({ gameId });

        if (!game) {
            console.log("Game not found. Creating a new game...");
            game = new Game({
                gameId, 
                status: "waiting",
                players: [],
            });
            await game.save();
        }

        // Prevent joining if game is already active
        if (game.status === "active") {
            return res.status(400).json({ error: "Game already started" });
        }

        // Check balance
        if (user.balance < betAmount) {
            return res.status(400).json({ error: "Insufficient balance" });
        }

        // Prevent duplicate players
        if (game.players.some(player => player.telegramId === telegramId)) {
            return res.status(400).json({ error: "Player already joined" });
        }

        // Deduct balance and save user
        user.balance -= betAmount;
        await user.save();

        // Add player
        game.players.push({ telegramId, betAmount });

        // **Check if it's the 2nd player**
        if (game.players.length === 2) {
            game.status = "countdown";
            await game.save();

            // **Start 10-second countdown**
            let countdown = 10;
            countdownValues[gameId] = countdown;

            gameTimers[gameId] = setInterval(async () => {
                if (countdownValues[gameId] > 0) {
                    countdownValues[gameId] -= 1;
                } else {
                    clearInterval(gameTimers[gameId]);
                    const updatedGame = await Game.findOne({ gameId });

                    if (updatedGame && updatedGame.players.length >= 2) {
                        updatedGame.status = "active";
                        await updatedGame.save();
                        console.log(`Game ${gameId} started!`);
                    }
                }
            }, 1000);
        }

        await game.save();

        res.json({
            message: game.players.length === 2 ? "Countdown started (10s)!" : "Joined game successfully",
            newBalance: user.balance,
            gameId: game.gameId,
            gameStatus: game.status,
            players: game.players.length,
            countdown: countdownValues[gameId] || null, // Send remaining countdown time
        });

    } catch (error) {
        console.error("Error joining game:", error);
        res.status(500).json({ error: "Server error" });
    }
});


router.get("/countdown/:gameId", async (req, res) => {
    const { gameId } = req.params;
    
    if (countdownValues[gameId] !== undefined) {
        return res.json({ countdown: countdownValues[gameId] });
    }
    
    return res.status(404).json({ error: "No countdown for this game" });
});




// 3. Get Game Details (Fetch the list of players in the game)
// router.get("/details/:gameId", async (req, res) => {
//   const { gameId } = req.params;

//   try {
//     const game = await Game.findOne({ gameId });
//     if (!game) {
//       return res.status(404).json({ error: "Game not found" });
//     }

//     res.json({
//       gameId: game.gameId,
//       players: game.players,
//       status: game.status,
//       startTime: game.startTime,
//     });
//   } catch (error) {
//     console.error("Error fetching game details:", error);
//     res.status(500).json({ error: "Server error" });
//   }
// });

module.exports = router;
