// checkandreset.js
const resetGame = require("./resetGame");
const GameControl = require("../models/GameControl");
const resetRound = require("./resetRound");

async function checkAndResetIfEmpty(gameId, io, redis, state) {
    // NEW: Check the master set of all active players for this game
    const currentPlayers = (await redis.sCard(gameRoomsKey)) || 0;
    const totalPlayers = await redis.sCard(`gamePlayers:${gameId}`);

    console.log(`[RESET CHECK] Game ${gameId}: Total Active Players: ${totalPlayers} (from gamePlayers:${gameId})`);

     if (currentPlayersInRoom === 0 && totalGamePlayers > 0) { // Only reset round if *some* total players exist
        console.log(`🧹 Game room ${strGameId} is empty. Initiating round reset.`);
        await resetRound(strGameId, io, state, redis);
        // Optionally set GameControl.isActive to false if this scenario means the game is paused/ended
        await GameControl.findOneAndUpdate({ gameId: strGameId }, { isActive: false });
        io.to(strGameId).emit("gameEnded", { gameId: strGameId, message: "Game room empty, round ended." });
        return false; // Not a full game reset
    }

    // The condition for resetting is if there are truly NO players left in the game at all.
    if (totalPlayers === 0) {
        console.log(`🧹 No players left in game ${gameId}. Resetting game...`);

        // Reset DB first
        try {
            await GameControl.findOneAndUpdate(
                { gameId },
                { isActive: false, totalCards: 0, prizeAmount: 0, players: [], endedAt: new Date() }
            );
            console.log(`✅ GameControl for game ${gameId} has been reset in DB.`);
        } catch (err) {
            console.error("❌ Error updating game status:", err);
        }

        // Reset Redis and memory (this will clear gameSessions, gameRooms, gamePlayers, gameCards etc.)
        await resetGame(gameId, io, state, redis);

        io.to(gameId).emit("gameEnded"); // Emit event to inform clients the game has ended
        return true; // Indicate that a reset occurred
    } else {
        console.log(`🟢 Game ${gameId} continues with ${totalPlayers} total players.`);
        // Ensure the current total player count is broadcast, even if no reset occurred.
        // This is important for UIs to update if a player left, but others remain.
        io.to(gameId).emit("gameid", { gameId, numberOfPlayers: totalPlayers });
        return false; // Indicate that no reset occurred
    }
}

module.exports = checkAndResetIfEmpty;