// routes/gameRoutes.js
const express = require("express");
const User = require("../models/user");
const Game = require("../models/game");
const router = express.Router();

const { v4: uuidv4 } = require('uuid'); // For unique game ID

// Middleware to handle errors
const handleError = (res, error, message) => {
    console.error(message, error);
    res.status(500).json({ error: message });
};

// Route to create a game
router.post("/create", async (req, res) => {
    try {
        const gameId = uuidv4(); // Generate a unique game ID
        const newGame = new Game({
            gameId,
            status: "waiting", // Initially, the game is waiting for players
            players: [], // Empty players array initially
            totalPrize: 0,
        });
        await newGame.save();
        res.json({
            message: "Game created successfully",
            gameId: newGame.gameId,
        });
    } catch (error) {
        handleError(res, error, "Error creating game:");
    }
});

// Route to join a game
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
            return res.status(404).json({ error: "Game not found" });
        }

        // Prevent joining if the game is already active
        if (game.status === "ongoing") {
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

        // Add player to game (store only ObjectId)
        game.players.push(user._id);
        game.totalPrize += betAmount; // Add bet amount to total prize

        // **If less than 2 players, game remains waiting**
        if (game.players.length < 2) {
            await game.save();
            return res.json({
                message: "Waiting for more players...",
                gameId: game.gameId,
                gameStatus: game.status,
                players: game.players.length,
                totalPrize: game.totalPrize,
            });
        }

        // Deduct the balance only when the player has successfully joined
        user.balance -= betAmount;
        await user.save();

        // Start the game when 2+ players join
        game.status = "ongoing"; 
        await game.save();

        res.json({
            message: "Joined game successfully",
            newBalance: user.balance,
            gameId: game.gameId,
            gameStatus: game.status,
            players: game.players.length,
            totalPrize: game.totalPrize,
            redirectToGamePage: true,  // Add this flag to handle frontend redirection
        });

    } catch (error) {
        handleError(res, error, "Error joining game:");
    }
});


// Route to check game status
router.get("/status", async (req, res) => {
    const { gameId } = req.query;

    if (!gameId) {
        return res.status(400).json({ error: "Game ID is required" });
    }

    try {
        const game = await Game.findOne({ gameId });
        if (!game) return res.status(404).json({ error: "Game not found" });

        res.json({ gameStatus: game.status, players: game.players.length, totalPrize: game.totalPrize });
    } catch (error) {
        handleError(res, error, "Error checking game status:");
    }
});

// Route to get game details (players, status, prize)
router.get("/details/:gameId", async (req, res) => {
    const { gameId } = req.params;

    try {
        const game = await Game.findOne({ gameId }).populate("players", "username balance telegramId");
        if (!game) {
            return res.status(404).json({ error: "Game not found" });
        }

        res.json({
            gameId: game.gameId,
            players: game.players, // This now returns full player details, not just IDs
            status: game.status,
            totalPrize: game.totalPrize,
            startTime: game.startTime,
        });
    } catch (error) {
        handleError(res, error, "Error fetching game details:");
    }
});

module.exports = router;
