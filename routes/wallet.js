// routes/api/wallet.js
const express = require('express');
const router = express.Router();
const User = require("../models/user"); // Import the User model


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


module.exports = router;
