const express = require('express');
const router = express.Router();
const GameHistory = require('../models/GameHistory');
const User = require('../models/user');

router.get('/:telegramId', async (req, res) => {
  const { telegramId } = req.params;

  try {
    const [user, games] = await Promise.all([
      User.findOne({ telegramId }),
      GameHistory.aggregate([
        { $match: { telegramId } },
        {
          $lookup: {
            from: 'gamehistories',
            localField: 'sessionId',
            foreignField: 'sessionId',
            as: 'allPlayersInGame'
          }
        },
        {
          $addFields: {
            totalPlayers: { $size: '$allPlayersInGame' }
          }
        },
        {
          $project: {
            sessionId: 1,
            gameId: 1,
            username: 1,
            telegramId: 1,
            eventType: 1,
            winAmount: 1,
            stake: 1,
            createdAt: 1,
            totalPlayers: 1
          }
        },
        { $sort: { createdAt: -1 } }
      ])
    ]);

    if (!user) {
      return res.status(404).json({ success: false, error: "User not found" });
    }

    const bonus = 0;
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
      games
    });
  } catch (err) {
    console.error('Profile fetch error:', err);
    return res.status(500).json({
      success: false,
      message: 'Profile data fetch failed',
    });
  }
});

