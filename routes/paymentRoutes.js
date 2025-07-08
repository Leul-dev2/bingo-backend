const express = require("express");
const router = express.Router();
const Payment = require("../models/payment");
const axios = require("axios");
const User  = require("../models/user")
const redis = require("../utils/redisClient"); // Import your Redis client

const CHAPA_SECRET_KEY = process.env.CHAPA_SECRET_KEY;

// 🆕 Route to return user info by telegramId
router.get("/userinfo", async (req, res) => {
  const { telegramId } = req.query;

  if (!telegramId) {
    return res.status(400).json({ message: "Missing telegramId" });
  }

  try {
    const user = await User.findOne({ telegramId });

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    // Respond with essential fields
    res.json({
      telegramId: user.telegramId,
      username: user.username,
      phoneNumber: user.phoneNumber,
    });
  } catch (err) {
    console.error("❌ Error fetching user info:", err.message);
    res.status(500).json({ message: "Server error" });
  }
});


router.post("/accept-payment", async (req, res) => {
  const {
    amount,
    currency,
    first_name,
    last_name,
    phone_number,
    tx_ref,
    telegramId, // ✅ Extract from frontend
  } = req.body;
  
  const user = await User.findOne({ telegramId });
  if (!user) {
    return res.status(404).json({ message: "User not found in DB" });
  }
  console.log("🔐 Incoming Payment Request started:", req.body);

  if (!telegramId) {
    return res.status(400).json({ message: "Missing telegramId" });
  }

  try {
    // ✅ Save payment with telegramId BEFORE calling Chapa
    await Payment.findOneAndUpdate(
      { tx_ref },
      {
        tx_ref,
        telegramId, // ✅ store it
        amount,
        currency,
        first_name,
        last_name,
        phone_number,
        status: "pending",
        createdAt: new Date(),
      },
      { upsert: true, new: true }
    );

    const chapaRes = await axios.post(
      "https://api.chapa.co/v1/transaction/initialize",
      {
        amount,
        currency,
        first_name,
        last_name,
        phone_number,
        tx_ref,
        return_url: "https://bossbingo.netlify.app/payment-success"
      },
      {
        headers: {
          Authorization: `Bearer ${CHAPA_SECRET_KEY}`,
          "Content-Type": "application/json",
        },
      }
    );

    console.log("✅ Chapa init response:", chapaRes.data);
    res.status(200).json(chapaRes.data);
  } catch (err) {
    console.error("❌ Chapa or DB error:", err.response?.data || err.message);
    res.status(400).json({ message: err.message, chapa: err.response?.data });
  }
});

// Webhook route: update payment status after Chapa confirms success
router.post("/webhook", express.json(), async (req, res) => {
  const data = req.body;

  if (data.status === "success") {
    const { tx_ref, amount } = data;

    // ✅ Find the payment
    const payment = await Payment.findOneAndUpdate(
      { tx_ref },
      { amount, status: "success", webhookTriggered: true },
      { new: true }
    );
    await redis.set(`userBalance:${telegramId}`, winnerUser.balance.toString());

    if (payment && payment.telegramId) {
      // ✅ Update user's balance
      const user = await User.findOneAndUpdate(
        { telegramId: payment.telegramId },
        { $inc: { balance: Number(amount) } }, // Make sure balance is a Number in schema
        { new: true }
      );

      console.log(`✅ Balance updated for user ${user.telegramId}: +${amount}`);
    } else {
      console.log("⚠️ Payment or telegramId not found, balance not updated.");
    }

    console.log(`✅ Webhook received: Payment success for ${tx_ref}`);
  } else {
    console.log("❌ Webhook received but status is not success");
  }

  res.sendStatus(200);
});

// Route to check payment status by tx_ref
router.get("/check-payment/:tx_ref", async (req, res) => {
  try {
    const tx = await Payment.findOne({ tx_ref: req.params.tx_ref });
    if (!tx) return res.json({ status: "pending" });
    res.json({ status: tx.status,amount: tx.amount  });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
});

module.exports = router;
