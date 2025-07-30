const express = require('express');
const router = express.Router();
const User = require("../models/user");
const GameControl = require('../models/GameControl'); // For when you need game control instances (later in socket code)
const GameConfiguration = require('../models/GameConfiguration'); // ⭐ NEW IMPORT
const redis = require("../utils/redisClient");

const { 
    getGameRoomsKey,
} = require("../utils/redisKeys");

router.post("/start", async (req, res) => {
    const { gameId, telegramId } = req.body; // gameId is the TYPE (e.g., "10")

    let gameConfig; // Renamed from 'game' to 'gameConfig' for clarity
    let user; // Declare user variable outside try block for scope in catch

    try {
        // 1. Find the game configuration for this gameId (e.g., "10")
        gameConfig = await GameConfiguration.findOne({ gameId });
        if (!gameConfig) {
            // If configuration doesn't exist, it means this game type is not defined.
            return res.status(404).json({ error: "Game type not found. Please provide a valid gameId." });
        }

        // 2. Check Redis membership for this game *type* room
        // This is where users indicate their intent to join a game of this type.
        const isMemberRedis = await redis.sIsMember(getGameRoomsKey(gameId), telegramId);

        // We no longer check `game.players.includes(telegramId)` here because `game`
        // (which is now `gameConfig`) doesn't have a `players` array.
        // `GameControl` (the session instance) will have the `players` array.

        // If already in the Redis room, prevent re-joining (for this specific game type)
        if (isMemberRedis) {
            return res.status(400).json({ error: "You are already waiting to join this game type." });
        }

        // 3. Proceed with join: lock user, deduct balance
        // We use gameConfig.stakeAmount here
        user = await User.findOneAndUpdate(
            {
                telegramId,
                transferInProgress: null,
                balance: { $gte: gameConfig.stakeAmount },
            },
            {
                $set: { transferInProgress: { type: "gameStart", at: Date.now() } },
                $inc: { balance: -gameConfig.stakeAmount },
            },
            { new: true }
        );

        if (!user) {
            return res.status(400).json({
                error: "Insufficient balance or transaction already in progress.",
            });
        }

        // Sync updated balance to Redis cache immediately
        await redis.set(`userBalance:${telegramId}`, user.balance.toString(), "EX", 60);

        // 4. Add user to the Redis set for this game *type* room
        // This indicates the user has paid and is ready for a session of this type.
        await redis.sAdd(getGameRoomsKey(gameId), telegramId);

        // 5. Release lock on user
        await User.updateOne(
            { telegramId },
            { $set: { transferInProgress: null } }
        );

        return res.status(200).json({
            success: true,
            gameId, // This is the game TYPE ID
            telegramId,
            message: "Joined game type successfully. Waiting for a round to start...",
        });

    } catch (error) {
        console.error("🔥 Game Start Error:", error);

        // Rollback balance & release lock on error
        if (user && gameConfig && error.message !== "You are already waiting to join this game type.") { // Don't rollback if already joined error
             await User.updateOne(
                { telegramId },
                {
                    $inc: { balance: gameConfig.stakeAmount || 0 }, // Use gameConfig stake
                    $set: { transferInProgress: null },
                }
            );
        } else if (user) { // If user was found but no gameConfig or other error
            await User.updateOne(
                { telegramId },
                { $set: { transferInProgress: null } }
            );
        }

        return res.status(500).json({ error: "Internal server error." });
    }
});




// ✅ Game Status Check
router.get('/:gameId/status', async (req, res) => {
    const { gameId } = req.params; // This is the game TYPE ID

    try {
        // 1. Get the CURRENTLY ACTIVE SESSION ID for this game type from Redis mapping
        const currentActiveSessionId = await redis.get(`gameSessionId:${gameId}`); // Use your getGameSessionIdKey helper if defined globally

        if (currentActiveSessionId) {
            // There's an active session mapped to this game type. Check its activity.
            const isActiveStr = await redis.get(`gameActive:${currentActiveSessionId}`); // Use getGameActiveKey helper

            if (isActiveStr !== null) {
                return res.json({
                    isActive: isActiveStr === 'true',
                    exists: true,
                    sessionId: currentActiveSessionId, // ⭐ Return the active session ID
                    message: "An active game session for this type is running."
                });
            }
        }

        // 2. If no current active session found in Redis, check the database for the *most recent* concluded session for this game type.
        // This is a more comprehensive check for the overall status of a game type.
        const gameControl = await GameControl.findOne(
            { gameId: gameId, endedAt: { $exists: true, $ne: null } } // Find by game type, and ensure it ended
        ).sort({ endedAt: -1 }); // Get the most recent concluded one

        if (gameControl) {
            // Found a recently concluded game session
            return res.json({
                isActive: false, // It's concluded
                exists: true,
                sessionId: gameControl.sessionId, // ⭐ Return the concluded session ID
                message: `The last game session (${gameControl.sessionId}) for this type concluded.`,
                winnerInfoAvailable: !!gameControl.winnerTelegramId // Indicate if winner data is available
            });
        }

        // If no active session and no recently concluded session, the game type might exist but no active/recent rounds.
        // Optionally, check if the game type even exists in GameConfiguration
        const gameConfig = await GameConfiguration.findOne({ gameId });
        if (gameConfig) {
            return res.json({
                isActive: false,
                exists: true,
                message: `Game type ${gameId} exists, but no active or recently concluded sessions.`,
                sessionId: null // No active session
            });
        } else {
            // Game type doesn't exist at all
            return res.status(404).json({
                isActive: false,
                message: 'Game type not found',
                exists: false,
                sessionId: null
            });
        }

    } catch (error) {
        console.error("Status check error:", error);
        return res.status(500).json({
            isActive: false,
            message: 'Server error',
            exists: false,
            sessionId: null
        });
    }
});


module.exports = router;
