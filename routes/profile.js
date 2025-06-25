const express = require('express');
const router = express.Router();
const GameHistory = require('../models/GameHistory');

router.get('/:telegramId', async (req, res) => {
  const { telegramId } = req.params;

  try {
    const games = await GameHistory.find({ telegramId });

    const balance = games.reduce((sum, g) => sum + (g.winAmount - g.stake), 0);
    const bonus = 0; // You can add real bonus logic later
    const coins = Math.floor(games.length / 3);

    const gamesWon = games.filter(g => g.eventType === 'win').length;

    const latestEntry = games[0]; // Already sorted by latest if you want
    const username = latestEntry && latestEntry.username ? latestEntry.username : '';

    return res.status(200).json({
      success: true,
      username,
      gamesWon,
      balance,
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
