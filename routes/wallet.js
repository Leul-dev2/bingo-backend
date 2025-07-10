// routes/api/wallet.js
const express = require('express');
const router = express.Router();
const User = require("../models/user"); // Import the User model
const Payment = require("../models/payment");
const Withdrawal = require("../models/withdrawal");


router.get('/', async (req, res) => {
  const { telegramId } = req.query;

  if (!telegramId) {
    return res.status(400).json({ error: "Missing telegramId" });
  }

  try {
    const user = await User.findOne({ telegramId });

    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    res.json({
      balance: user.balance,
      phoneNumber: user.phoneNumber,
    });
  } catch (error) {
    console.error("Error fetching user data:", error);
    res.status(500).json({ error: "Server error" });
  }
});


router.get('/history', async (req, res) => {
  const { telegramId } = req.query;
  if (!telegramId) return res.status(400).json({ error: 'Missing telegramId' });

  try {
    const deposits = await Payment.find({ telegramId }).sort({ createdAt: -1 });
    const withdrawals = await Withdrawal.find({ telegramId }).sort({ createdAt: -1 });

    res.json({ deposits, withdrawals });
  } catch (error) {
    console.error("Error fetching history:", error);
    res.status(500).json({ error: "Server error" });
  }
});



module.exports = router;
