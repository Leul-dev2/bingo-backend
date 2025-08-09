// utils/checkandreset.js
const resetGame = require("./resetGame");
const GameControl = require("../models/GameControl");
const resetRound = require("./resetRound");
const { getGameRoomsKey, getGamePlayersKey} = require("./redisKeys"); // <-- ADD THIS LINE

async function checkAndResetIfEmpty(gameId, GameSessionId, socket, io, redis, state) {
    const strGameId = String(gameId); // Ensure gameId is always a string for Redis keys

    // Use the helper functions for Redis keys
    const gameRoomsRedisKey = getGameRoomsKey(strGameId);
    const gamePlayersRedisKey = getGamePlayersKey(strGameId);

    // Get current players in the active game room (those who have a selected card and are playing)
    const currentPlayersInRoom = (await redis.sCard(gameRoomsRedisKey)) || 0;
    console.log("currentPlayersInRoom", currentPlayersInRoom)
    // Get total players who have ever joined this game instance (even if they've left the current round)
    const totalPlayersOverall = (await redis.sCard(gamePlayersRedisKey)) || 0;
    console.log("total players", totalPlayersOverall);

    console.log(`[RESET CHECK] Game ${strGameId}: Players in current round: ${currentPlayersInRoom}, Total players in game instance: ${totalPlayersOverall}`);

    // Scenario 1: No players currently in the active game room (round ended due to abandonment)
   if (currentPlayersInRoom === 0) {
    console.log(`🛑 All players left game room ${strGameId}. Triggering round reset.`);


    if (!state || !state[gameId]) {
    console.error(`resetRound: No state found for gameId ${gameId} ⏳🎯⏳`);
        return;
    }

    
    // Add a check to ensure the state object is valid before passing it
    if (state && typeof state.countdownIntervals !== 'undefined') {
        // Also ensure all other necessary properties are present
        if (state.drawIntervals && state.drawStartTimeouts) {
            // Call resetRound, but be careful with the number of arguments
            // The signature of resetRound is `(gameId, GameSessionId, socket, io, state, redis)`
            // If you don't have a `socket` object, you'll need to pass `null` or `undefined`
            // and update resetRound to handle this.
            await resetRound(gameId, GameSessionId, socket, io, redis, state);
        } else {
            console.error('❌ Error: State object is incomplete. Missing drawIntervals or drawStartTimeouts.');
        }
    } else {
        console.error('❌ Error: State object is invalid or missing.');
    }
}

    // Scenario 2: No players left in the entire game instance (full game abandonment)
    if (totalPlayersOverall === 0) {
        console.log(`🧹 No players left in game instance ${strGameId}. Resetting full game...`);

        // Reset DB first (isActive, totalCards, prizeAmount, players array)
        try {
            await GameControl.findOneAndUpdate(
                { gameId: strGameId },
                { $set: { isActive: false, totalCards: 0, prizeAmount: 0, players: [], endedAt: new Date() } }
            );
            console.log(`✅ GameControl for game ${strGameId} has been reset in DB.`);
        } catch (err) {
            console.error(`❌ Error updating GameControl for game ${strGameId}:`, err);
            // Consider what happens if DB update fails. Should the Redis reset still proceed?
            // For now, proceed, assuming Redis is the primary source of truth for immediate state.
        }

        // Perform a full game reset (Redis keys, in-memory state)
        await resetGame(strGameId, io, state, redis);

        io.to(strGameId).emit("gameEnded", { gameId: strGameId, message: "Game has ended due to all players leaving." }); // Add message for clarity
        return true; // Indicate that a full game reset occurred
    } else {
        console.log(`🟢 Game ${strGameId} continues with ${totalPlayersOverall} total players.`);
        // Ensure the current total player count is broadcast, even if no reset occurred.
        // This is important for UIs to update if a player left, but others remain.
        io.to(strGameId).emit("gameid", { gameId: strGameId, numberOfPlayers: totalPlayersOverall });
        return false; // Indicate that no full game reset occurred
    }
}

module.exports = checkAndResetIfEmpty;