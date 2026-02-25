const { Worker } = require('bullmq');
const mongoose = require('mongoose');
const GameCard = require("./models/GameCard");
const bingoCards = require("./assets/bingoCards.json");
const { connection } = require("./utils/dbQueue");

const SHUTDOWN_TIMEOUT_MS = 45000;

mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log("📦 Worker connected to MongoDB"))
  .catch(err => console.error("MongoDB Worker Error:", err));

const worker = new Worker('db-operations', async (job) => {
  const { type, payload } = job.data;
  const { gameId, telegramId, cardIds } = payload;

  if (type === 'SAVE_CARDS') {
    const ops = cardIds.map(cardId => {
      const cardObj = bingoCards.find(c => Number(c.id) === Number(cardId));
      if (!cardObj) throw new Error(`Card ${cardId} missing from JSON`);
      
      const cleanCard = cardObj.card.map(row => row.map(c => c === "FREE" ? 0 : Number(c)));
      return {
        updateOne: {
          filter: { gameId: String(gameId), cardId: Number(cardId) },
          update: { $set: { card: cleanCard, isTaken: true, takenBy: Number(telegramId) } },
          upsert: true
        }
      };
    });
    await GameCard.bulkWrite(ops);
    console.log(`✅ Saved ${ops.length} cards | game=${gameId} user=${telegramId}`);
  } 

  else if (type === 'RELEASE_CARDS') {
    const numericIds = cardIds.map(id => Number(id));
    await GameCard.updateMany(
      { gameId: String(gameId), cardId: { $in: numericIds } },
      { $set: { isTaken: false, takenBy: null } }
    );
    console.log(`🔓 Released ${numericIds.length} cards | game=${gameId}`);
  }
}, { 
  connection,
  concurrency: 5,           // Process 5 writes in parallel
  lockDuration: 60000,      // Allow 60s for slow DB operations
  stalledInterval: 30000,   // Check for stalled workers every 30s
  limiter: { max: 20, duration: 1000 } // Global rate limit: 20 jobs/sec
});

// Monitoring
worker.on('failed', (job, err) => console.error(`❌ Job ${job.id} failed:`, err.message));
worker.on('stalled', (jobId) => console.warn(`⚠️ Job ${jobId} stalled! Another worker will retry.`));
worker.on('completed', (job) => console.log(`🏁 Job ${job.id} complete`));

// Graceful Shutdown Logic
async function gracefulShutdown(signal) {
  console.log(`\nReceived ${signal}. Starting graceful shutdown...`);
  try {
    await worker.pause(); // Stop taking new jobs
    
    const closePromise = worker.close();
    const timeoutPromise = new Promise((_, reject) => 
      setTimeout(() => reject(new Error('Shutdown timed out')), SHUTDOWN_TIMEOUT_MS)
    );

    await Promise.race([closePromise, timeoutPromise]);
    console.log('Worker closed gracefully.');
  } catch (err) {
    console.error('Shutdown error:', err.message);
    await worker.close(true); // Force close
  } finally {
    await mongoose.connection.close();
    process.exit(0);
  }
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('unhandledRejection', (reason) => console.error('Unhandled Rejection:', reason));