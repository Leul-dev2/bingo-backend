const express = require('express');
const router = express.Router();
const GameHistory = require('../models/GameHistory');
const { userRateLimiter, globalRateLimiter } = require('../rate-limit/historyLimiter');

router.get('/', async (req, res) => {
  const timeframe = req.query.time || 'all';
  let dateFilter = null;

  switch (timeframe) {
    case '24hr':
      dateFilter = new Date(Date.now() - 24 * 60 * 60 * 1000);
      break;
    case '7days':
      dateFilter = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      break;
    case '30days':
      dateFilter = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      break;
    case 'all':
    default:
      dateFilter = null;
      break;
  }

   // ✅ Rate limit before any DB operations
  const telegramId = req.query.telegramId || req.ip; // fallback to IP for anonymous usage
  try {
    await Promise.all([
      userRateLimiter.consume(telegramId),
      globalRateLimiter.consume("global")
    ]);
  } catch (rateLimitError) {
    return res.status(429).json({
      error: "Too many requests. Please wait before trying again."
    });
  }



  const pipeline = [];

  if (dateFilter) {
    pipeline.push({
      $match: {
        createdAt: { $gte: dateFilter },
      },
    });
  }

  pipeline.push(
    {
      $group: {
        _id: "$telegramId",
        username: { $first: "$username" },
        gamesPlayed: { $sum: 1 },
      },
    },
    { $sort: { gamesPlayed: -1 } },
    { $limit: 100 }
  );

  try {
    const players = await GameHistory.aggregate(pipeline);
    return res.status(200).json(players);
  } catch (error) {
    console.error('Top players fetch error:', error);
    return res.status(500).json({ message: 'Failed to get top players' });
  }
});

module.exports = router;
