// routes/profile.js
const express = require('express');
const router = express.Router();
const GameHistory = require('../models/GameHistory');

router.get('/:telegramId', async (req, res) => {
  const { telegramId } = req.params;
  try {
    const gamesWon = await GameHistory.countDocuments({ telegramId, eventType: 'win' });
    const user = await GameHistory.findOne({ telegramId }).sort({ createdAt: -1 });
    return res.json({ username: user?.username || '', gamesWon });
  } catch (err) {
    console.error('Profile fetch error:', err);
    return res.status(500).json({ message: 'Profile data fetch failed' });
  }
});

module.exports = router;
