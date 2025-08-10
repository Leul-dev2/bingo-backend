const express = require('express');
const router = express.Router();
const User = require("../models/user");
const Payment = require("../models/payment");
const Withdrawal = require("../models/withdrawal");
const { userRateLimiter, globalRateLimiter } = require('../rate-limit/Limiter');

router.get('/', async (req, res) => {
  const { telegramId } = req.query;

  if (!telegramId) {
    return res.status(400).json({ error: "Missing telegramId" });
  }

  // Rate limit check
  try {
    await Promise.all([
      userRateLimiter.consume(telegramId),
      globalRateLimiter.consume("global"),
    ]);
  } catch (rateLimitError) {
    return res.status(429).json({
      error: "Too many requests. Please wait before trying again.",
      retryAfter: 5,
    });
  }

  try {
    // Fetch user, deposits, and withdrawals in parallel
    const [user, deposits, withdrawals] = await Promise.all([
      User.findOne({ telegramId }),
      Payment.find({ telegramId }, 'tx_ref amount status createdAt').sort({ createdAt: -1 }),
      Withdrawal.find({ telegramId }, 'tx_ref amount status createdAt').sort({ createdAt: -1 }),
    ]);

    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    res.json({
      balance: user.balance,
      phoneNumber: user.phoneNumber,
      deposits,
      withdrawals,
    });
  } catch (error) {
    console.error("Error fetching wallet data:", error);
    res.status(500).json({ error: "Server error" });
  }
});

module.exports = router;
