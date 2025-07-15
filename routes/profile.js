const express = require('express');
const router = express.Router();
const GameHistory = require('../models/GameHistory');
const User = require('../models/user');
const { userRateLimiter, globalRateLimiter } = require('../rate-limit/Limiter');

router.get('/:telegramId', async (req, res) => {
  const { telegramId } = req.params;


  /*They’ll get a raw HTTP 429 response with:
{
  "error": "Too many requests. Please wait before trying again."
}*/
// ✅ First: Rate limit check (before DB call)
  try {
    await Promise.all([
      userRateLimiter.consume(telegramId),   // Limit per user
      globalRateLimiter.consume("global")    // Global limit
    ]);
  } catch (rateLimitError) {
    return res.status(429).json({
      success: false,
      error: "Too many requests. Please wait before trying again."
    });
  }
  try {
    // Fetch user and game history in parallel
    const [user, games] = await Promise.all([
      User.findOne({ telegramId }),
      GameHistory.find({ telegramId }),
    ]);

    // Check if user exists
    if (!user) {
      return res.status(404).json({ success: false, error: "User not found" });
    }

    const bonus = 0; // 🔧 Placeholder for future bonus logic
    const coins = Math.floor(games.length / 3);
    const gamesWon = games.filter(g => g.eventType === 'win').length;
    const latestEntry = games[0];
    const username = latestEntry?.username || user.username || 'Unknown';

    return res.status(200).json({
      success: true,
      username,
      gamesWon,
      balance: user.balance,
      bonus,
      coins,
    });
  } catch (err) {
    console.error('Profile fetch error:', err);
    return res.status(500).json({
      success: false,
      message: 'Profile data fetch failed',
    });
  }
});

module.exports = router;
