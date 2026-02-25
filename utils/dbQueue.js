const { Queue, QueueEvents } = require('bullmq');
const IORedis = require('ioredis');

const redisUrl = process.env.REDIS_URL || 'redis://127.0.0.1:6379';

// Shared ioredis connection for BullMQ
const connection = new IORedis(redisUrl, {
  maxRetriesPerRequest: null,
});

// 1. The Queue (Producer)
const dbQueue = new Queue('db-operations', { connection });

// 2. Global Observability (Alerting)
const queueEvents = new QueueEvents('db-operations', { connection });

queueEvents.on('failed', ({ jobId, failedReason }) => {
  console.error(`🚨 PERMANENT FAILURE — Job ${jobId}: ${failedReason}`);
  // In production, trigger a Telegram alert or Sentry event here
});

// 3. Centralized Job Config
const defaultJobOptions = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 2000 },
  removeOnComplete: { age: 86400, count: 5000 }, // Keep for 24h / last 5k jobs
  removeOnFail: { age: 86400 * 7 },               // Keep failed for 7 days
};

module.exports = { dbQueue, connection, defaultJobOptions };