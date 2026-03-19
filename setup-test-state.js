require("dotenv").config();
const mongoose = require("mongoose");
const Redis = require("ioredis");
const GameControl = require("./models/GameControl"); 
const PlayerSession = require("./models/PlayerSession"); // Added this

const redis = new Redis(process.env.REDIS_URL);
const GAME_ID = "10";
const SESSION_ID = "TEST_SESSION_10";

async function setupState() {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log("✅ Connected to MongoDB");

    // 1. Clear old Game Data
    await GameControl.deleteMany({ GameSessionId: SESSION_ID });
    console.log(`🧹 Cleared old game data for Session: ${SESSION_ID}`);

    // 2. Setup MongoDB GameControl (Match schema exactly)
    await GameControl.create({
        gameId: GAME_ID,
        GameSessionId: SESSION_ID,
        prizeAmount: 5000,
        houseProfit: 500,
        stakeAmount: 100,
        totalCards: 200,
        isActive: true,
        status: 'active'
    });
    console.log("✅ MongoDB GameControl initialized.");

    // 3. Setup Redis State (Matching your backend logic)
    // Your checkWinner.js uses getDrawnNumbersSet which usually reads 'gameDraws:ID'
    const gameDrawsKey = `gameDraws:${SESSION_ID}`;
    const gameIsActiveKey = `gameIsActive:${GAME_ID}`;
    
    // Clear all potential locks/state
    await redis.del(
        gameDrawsKey,
        gameIsActiveKey,
        `winnerLock:${SESSION_ID}`, 
        `winnerDeclared:${SESSION_ID}`,
        `winnerInfo:${SESSION_ID}`,
        `connectedCount:${SESSION_ID}`
    );
    
    // RPUSH '25' so it's a valid drawn number for your dummy cards
    await redis.rpush(gameDrawsKey, "25");
    // SET gameIsActive so checkWinner doesn't reject for 'game not started'
    await redis.set(gameIsActiveKey, "true");

    console.log("✅ Redis state primed: Number 25 is 'drawn' in List 'gameDraws'.");
    
    

    console.log("\n🚀 SYSTEM READY!");
    console.log("1. Ensure 'seed-real-players.js' was run.");
    console.log("2. Restart your backend server.");
    console.log("3. Run: node winner_simulate");

  } catch (err) {
    console.error("❌ Setup failed:", err);
  } finally {
    await mongoose.disconnect();
    // Use quit() to ensure it closes properly
    await redis.quit();
  }
}

setupState();