const express = require("express");
const User = require("../models/user"); // Import the User model
const router = express.Router();

// Sample route to check if the users route is working
router.get("/", (req, res) => {
  res.json({ message: "Users is connected" });
});


// ✅ **New Route: Fetch user balance by telegramId**

router.get("/getUser", async (req, res) => {
  const { telegramId } = req.query; // Extract telegramId from query

  if (!telegramId) {
    return res.status(400).json({ error: "Missing telegramId" });
  }

  try {
    const user = await User.findOne({ telegramId });

    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    res.json({ balance: user.balance });
  } catch (error) {
    console.error("Error fetching user data:", error);
    res.status(500).json({ error: "Server error" });
  }
});

module.exports = router;
