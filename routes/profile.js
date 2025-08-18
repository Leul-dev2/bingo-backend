const express = require('express');
const router = express.Router();
const GameHistory = require('../models/GameHistory');
const User = require('../models/user');
const { userRateLimiter, globalRateLimiter } = require('../rate-limit/Limiter');

router.get('/:telegramId', async (req, res) => {
  const { telegramId } = req.params;

  try {
    // Rate limiting first
    await Promise.all([
      userRateLimiter.consume(telegramId),
      globalRateLimiter.consume('global'),
    ]);
  } catch (rateLimitError) {
    return res.status(429).json({
      error: 'Too many requests. Please wait before trying again.',
      retryAfter: 5,
    });
  }

  try {
    // Fetch user and game history in parallel
    const [user, games] = await Promise.all([
      User.findOne({ telegramId }),
      GameHistory.find({ telegramId }),
    ]);

    if (!user) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    const bonus = 0; // placeholder for future bonus logic
    const coins = 0; // FAKE FOR NOW
    const gamesWon = games.filter((g) => g.eventType === 'win').length;
    const username = User.username[0] || "Unknown"

    return res.status(200).json({
      success: true,
      username,
      gamesWon,
      balance: user.balance,
      bonus,
      coins,
    });
  } catch (err) {
    console.error('Combined fetch error:', err);
    return res.status(500).json({
      success: false,
      message: 'Profile data fetch failed',
    });
  }
});

module.exports = router;
