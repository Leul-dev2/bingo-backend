// dbWorker.js
console.log("╔════════════════════════════════════════════╗");
console.log("║     DB WORKER PROCESS STARTED - PID:", process.pid, "     ║");
console.log("║             Time:", new Date().toISOString(), "║");
console.log("╚════════════════════════════════════════════╝");

require('dotenv').config();
const { Worker } = require('bullmq');
const mongoose = require('mongoose');
const GameCard = require("./models/GameCard");
const bingoCards = require("./assets/bingoCards.json");
const { connection } = require("./utils/dbQueue");
const connectDB = require("./config/db");

const SHUTDOWN_TIMEOUT_MS = 45000;

console.log("[START] Required all modules successfully");

connectDB()
  .then(() => {
    console.log("[DB] MongoDB connection established");
    console.log("[DB] Database name:", mongoose.connection.db?.databaseName || "unknown");
    console.log("[DB] Ready state:", mongoose.connection.readyState);

    const worker = new Worker('db-operations', async (job) => {
      console.log(`[JOB START] ${job.id} | ${job.name} | type: ${job.data?.type || 'unknown'}`);

      const { type, payload } = job.data || {};
      if (!payload) {
        throw new Error("Job payload is missing");
      }

      const { gameId, telegramId, cardIds } = payload;

      if (type === 'SAVE_CARDS') {
        if (!Array.isArray(cardIds) || cardIds.length === 0) {
          console.warn("[SAVE] No cards to save");
          return;
        }

        const ops = cardIds.map(cardId => {
          const cardObj = bingoCards.find(c => Number(c.id) === Number(cardId));
          if (!cardObj) {
            console.warn(`[SAVE] Card ${cardId} not found in JSON`);
            return null;
          }

          const cleanCard = cardObj.card.map(row =>
            row.map(c => (c === "FREE" ? 0 : Number(c)))
          );

          return {
            updateOne: {
              filter: { gameId: String(gameId), cardId: Number(cardId) },
              update: { $set: { card: cleanCard, isTaken: true, takenBy: Number(telegramId) } },
              upsert: true
            }
          };
        }).filter(Boolean);

        if (ops.length === 0) {
          console.log("[SAVE] No valid operations to execute");
          return;
        }

        const result = await GameCard.bulkWrite(ops, { ordered: false });
        console.log(`[SAVE SUCCESS] ${ops.length} cards → bulkWrite result:`, result);
      }
      else if (type === 'RELEASE_CARDS') {
        if (!Array.isArray(cardIds) || cardIds.length === 0) {
          console.warn("[RELEASE] No cards to release");
          return;
        }

        const numericIds = cardIds.map(id => Number(id));
        const result = await GameCard.updateMany(
          { gameId: String(gameId), cardId: { $in: numericIds } },
          { $set: { isTaken: false, takenBy: null } }
        );

        console.log(`[RELEASE SUCCESS] game=${gameId} → matched: ${result.matchedCount}, modified: ${result.modifiedCount}`);
      }
      else {
        throw new Error(`Unknown job type: ${type}`);
      }
    }, {
      connection,
      concurrency: 5,
      lockDuration: 60000,
      stalledInterval: 30000,
      maxStalledCount: 3,
      limiter: { max: 20, duration: 1000 }
    });

    console.log("[WORKER] Worker instance created successfully");

    worker.on('failed', (job, err) => {
      console.error(`[JOB FAILED] ${job?.id || '?'}: ${err.message}`);
    });

    worker.on('stalled', (jobId) => {
      console.warn(`[JOB STALLED] ${jobId} → will be retried`);
    });

    worker.on('completed', (job) => {
      console.log(`[JOB COMPLETED] ${job.id}`);
    });
  })
  .catch(err => {
    console.error("[FATAL] MongoDB connection failed in worker", err);
    process.exit(1);
  });

// Graceful shutdown
async function gracefulShutdown(signal) {
  console.log(`\n[${signal}] Starting graceful shutdown...`);
  try {
    // Pause accepting new jobs
    // (worker.pause() is missing in your code — add it)
    // await worker.pause();   ← uncomment when worker is defined in scope

    const closePromise = worker.close();
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Shutdown timeout')), SHUTDOWN_TIMEOUT_MS)
    );

    await Promise.race([closePromise, timeoutPromise]);
    console.log("Worker closed gracefully");
  } catch (err) {
    console.error("Shutdown failed:", err.message);
    await worker?.close(true).catch(() => {});
  } finally {
    await mongoose.connection.close().catch(() => {});
    console.log("MongoDB connection closed");
    process.exit(0);
  }
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});