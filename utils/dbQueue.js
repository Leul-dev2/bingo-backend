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
  backoff: { type: 'exponential', delay: 2000 },
  removeOnComplete: 5,   // keep only last 5 completed jobs
  removeOnFail:     50,  // keep last 50 failed for debugging
  attempts:         3,
};

module.exports = { dbQueue, connection, defaultJobOptions };