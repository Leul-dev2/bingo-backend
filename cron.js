const cron = require("node-cron");
const Game = require("./models/game");

// Run every 5 seconds to check for games that need to start
cron.schedule("*/5 * * * * *", async () => {
  try {
    // Find games that are waiting and have a timer started
    const games = await Game.find({ gameStatus: "waiting", timerStart: { $ne: null } });

    for (const game of games) {
      const timeElapsed = new Date() - new Date(game.timerStart); // Calculate elapsed time

      // If 15 seconds have passed since the game was created, start the game
      if (timeElapsed >= 15000) {
        game.gameStatus = "active"; // Set the game to active
        game.timerStart = null; // Reset the timer
        await game.save();
        console.log(`Game ${game.gameId} started automatically after 15 seconds.`);
      }
    }
  } catch (error) {
    console.error("Error in scheduled task:", error);
  }
});
