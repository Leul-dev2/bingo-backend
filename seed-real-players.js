// seed-real-players.js
require("dotenv").config();
const mongoose = require("mongoose");
const User = require("./models/user");        // ← adjust path if your models are elsewhere
const GameCard = require("./models/GameCard");

const GAME_ID = "10";           // ← same gameId you use in simulation
const TOTAL_USERS = 100;

async function seedTestData() {
    try {
        await mongoose.connect(process.env.MONGODB_URI);
        console.log("✅ Connected to MongoDB");

        console.log("🧹 Cleaning old test data...");
        await User.deleteMany({ telegramId: { $gte: 900000, $lte: 900999 } });
        await GameCard.deleteMany({ gameId: GAME_ID, cardId: { $gte: 1, $lte: 300 } });

        console.log(`Creating ${TOTAL_USERS} real test users + reserved cards...`);

        for (let i = 0; i < TOTAL_USERS; i++) {
            const telegramId = 900000 + i;

            // 1. Create user with good balance
            await User.findOneAndUpdate(
                { telegramId },
                {
                    username: `TestPlayer${i}`,
                    phoneNumber: `+2519${telegramId}`,
                    balance: 10000,
                    bonus_balance: 5000,
                    reservedForGameId: null
                },
                { upsert: true, new: true }
            );

            // 2. Reserve 1 or 2 cards for this user
            const numCards = (i % 3 === 0) ? 2 : 1;
            for (let c = 0; c < numCards; c++) {
                const cardId = (i * 3) + c + 1;   // unique card numbers 1–300

                await GameCard.findOneAndUpdate(
                    { gameId: GAME_ID, cardId },
                    {
                        card: Array(5).fill().map(() => Array(5).fill(Math.floor(Math.random()*90)+1)), // fake 5x5 bingo card
                        isTaken: true,
                        takenBy: String(telegramId)   // ← important: takenBy is String in your schema
                    },
                    { upsert: true }
                );
            }
        }

        console.log(`🎉 SUCCESS! Created ${TOTAL_USERS} real users + ${TOTAL_USERS * 1.3} reserved cards for gameId ${GAME_ID}`);
        console.log("You can now run the simulation with real data!");

    } catch (err) {
        console.error("❌ Seed failed:", err.message);
    } finally {
        await mongoose.disconnect();
    }
}

seedTestData();