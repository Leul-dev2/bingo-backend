// history.js
const express = require('express');
const router = express.Router();
const GameHistory = require('../models/GameHistory');
const { userRateLimiter, globalRateLimiter } = require('../rate-limit/Limiter');

// Simple in-memory cache for "Recent Games" (public tab) - survives 5000+ users
const recentCache = new Map(); // key = bet (string), value = { data, timestamp }
const CACHE_TTL = 5000; // 5 seconds

router.get('/', async (req, res) => {
  const { user, bet, tab } = req.query;
  if (!user || !bet) {
    return res.status(400).json({ error: 'Missing user or bet' });
  }

  const stake = parseInt(bet, 10);
  if (isNaN(stake)) {
    return res.status(400).json({ error: 'Invalid bet value' });
  }

  // Build query
  const match = { stake };
  if (tab === '0') {
    match.eventType = 'win';           // Recent Games = public winners only
  } else {
    match.telegramId = user;           // My Games = user's full history
  }

  // ==================== RATE LIMIT (non-blocking) ====================
  try {
    await Promise.all([
      userRateLimiter.consume(user),
      globalRateLimiter.consume('global'),
    ]);
  } catch {
    return res.status(429).json({
      error: 'Too many requests. Please wait before trying again.',
      retryAfter: 5,
    });
  }

  // ==================== CACHE FOR RECENT GAMES (tab=0) ====================
  const cacheKey = `recent_${stake}`;
  if (tab === '0') {
    const cached = recentCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
      return res.json(cached.data);   // Instant response for 5000+ users
    }
  }

  try {
    const games = await GameHistory.find(match)
      .sort({ createdAt: -1 })
      .limit(100)
      .lean();

    const transformed = games.map(g => ({
      id: g.sessionId.slice(-4),
      user: g.username,
      ref: g.sessionId.slice(-4),
      board: Array.isArray(g.cartelaIds) && g.cartelaIds.length ? g.cartelaIds[0] : 'N/A',
      calls: g.callNumberLength || 0,
      date: new Date(g.createdAt).toLocaleDateString(),
      time: new Date(g.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      win: g.eventType === 'lose' ? -g.stake : g.winAmount,
    }));

    // Save to cache if it's Recent Games
    if (tab === '0') {
      recentCache.set(cacheKey, { data: transformed, timestamp: Date.now() });
    }

    return res.json(transformed);
  } catch (err) {
    console.error('History fetch error:', err);
    return res.status(500).json({ message: 'Failed to fetch history' });
  }
});

module.exports = router;