// reseed-test-players.js
require("dotenv").config();
const mongoose = require("mongoose");
const User = require("./models/user");
const GameCard = require("./models/GameCard");

const GAME_ID = "10";
const TOTAL_USERS = 100;
const START_TELEGRAM = 900000;

async function seedTestData() {
    try {
        await mongoose.connect(process.env.MONGODB_URI);
        console.log("✅ Connected to MongoDB");

        // Clean old data
        await User.deleteMany({ telegramId: { $gte: START_TELEGRAM, $lte: START_TELEGRAM + TOTAL_USERS + 10 } });
        await GameCard.deleteMany({ gameId: GAME_ID });

        console.log(`Creating ${TOTAL_USERS} users + reserved cards...`);

        for (let i = 0; i < TOTAL_USERS; i++) {
            const telegramId = START_TELEGRAM + i;
            const numCards = (i % 3 === 0) ? 2 : 1;

            // Create user
            await User.findOneAndUpdate(
                { telegramId },
                {
                    username: `TestPlayer${i}`,
                    balance: 10000,
                    bonus_balance: 5000,
                    reservedForGameId: null
                },
                { upsert: true, new: true }
            );

            // Reserve 1 or 2 cards
            for (let c = 0; c < numCards; c++) {
                const cardId = (i * 3) + c + 1;
                await GameCard.findOneAndUpdate(
                    { gameId: GAME_ID, cardId },
                    {
                        card: Array(5).fill().map(() => Array(5).fill(25)), // dummy bingo card
                        isTaken: true,
                        takenBy: String(telegramId)
                    },
                    { upsert: true }
                );
            }
        }

        console.log(`🎉 SUCCESS! ${TOTAL_USERS} users + cards created for gameId ${GAME_ID}`);
    } catch (err) {
        console.error("❌ Seed error:", err.message);
    } finally {
        await mongoose.disconnect();
    }
}

seedTestData();