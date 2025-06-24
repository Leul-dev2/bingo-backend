// routes/profile.js
const express = require('express');
const router = express.Router();
const GameHistory = require('../models/GameHistory');

router.get('/:telegramId', async (req, res) => {
  const { telegramId } = req.params;
  try {
    const gamesWon = await GameHistory.countDocuments({ telegramId, eventType: 'win' });
    const latestEntry = await GameHistory.findOne({ telegramId }).sort({ createdAt: -1 });

    const username = latestEntry && latestEntry.username ? latestEntry.username : '';

    return res.json({
      success: true,
      username,
      gamesWon,
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
