// routes/api/wallet.js
const express = require('express');
const router = express.Router();
const GameHistory = require('../../models/GameHistory');

router.get('/:telegramId', async (req, res) => {
  const { telegramId } = req.params;

  try {
    const games = await GameHistory.find({ telegramId });

    const balance = games.reduce((sum, g) => sum + (g.winAmount - g.stake), 0);
    const bonus = 0; // You can customize logic if needed
    const coins = Math.floor(games.length / 3);

    res.status(200).json({ balance, bonus, coins });
  } catch (error) {
    console.error('Wallet fetch error:', error);
    res.status(500).json({ message: 'Failed to fetch wallet' });
  }
});

module.exports = router;
