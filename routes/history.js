const express = require('express');
const router = express.Router();
const GameHistory = require('../models/GameHistory');
const { userRateLimiter, globalRateLimiter } = require('../rate-limit/Limiter');

// GET /api/history?user=123&bet=10&tab=0|1
router.get('/', async (req, res) => {
  const { user, bet, tab } = req.query;
  if (!user || !bet) return res.status(400).json({ error: 'Missing user or bet' });



  const match = {
    telegramId: user,
    stake: parseInt(bet),
  };

  // Optional: tab=0 => "Recent Games" = all users, tab=1 => "My Games" = only user's games
  if (tab === '0') delete match.telegramId;

   try {
    // ✅ Apply both user and global rate limits
    await Promise.all([
      userRateLimiter.consume(user),        // limit per user
      globalRateLimiter.consume("global")   // limit total requests
    ]);
  } catch (rateLimitError) {
    return res.status(429).json({
      error: "Too many requests. Please wait before trying again."
    });
  }


  try { 
    
   
    const games = await GameHistory.find(match)
      .sort({ createdAt: -1 })
      .limit(100)
      .lean();

   const transformed = games.map(g => ({
  id: g.sessionId.slice(-4), // last 4 as ref
  user: g.username,
  ref: g.sessionId,
  board: Math.floor(Math.random() * 50), // fake for now
  calls: Math.floor(Math.random() * 25), // fake for now
  date: new Date(g.createdAt).toLocaleDateString(),
  time: new Date(g.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
 win: g.eventType === 'lose' ? -g.stake : g.winAmount,}));


    return res.json(transformed);
  } catch (err) {
    console.error('History fetch error:', err);
    return res.status(500).json({ message: 'Failed to fetch history' });
  }
});

module.exports = router;
