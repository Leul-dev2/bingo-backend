const express = require("express");
const router = express.Router();
const Payment = require("../models/payment");
const axios = require("axios");
const User  = require("../models/user")
const redis = require("../utils/redisClient"); // Import your Redis client
const Withdrawal = require("../models/withdrawal");

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





router.get("/balance", async (req, res) => {
  const { telegramId } = req.query;

  if (!telegramId) {
    return res.status(400).json({ message: "Missing telegramId" });
  }

  try {
    const user = await User.findOne({ telegramId });

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    // Respond only with balance
    return res.json({ balance: user.balance ?? 0 });
  } catch (err) {
    console.error("❌ Error fetching user balance:", err.message);
    return res.status(500).json({ message: "Server error" });
  }
})


router.post("/request-withdrawal", async (req, res) => {
  const {
    telegramId,
    bank_code,
    account_name,
    account_number,
    amount,
    currency,
    reference,
  } = req.body;

  if (!telegramId || !bank_code || !account_name || !account_number || !amount || !currency || !reference) {
    return res.status(400).json({ message: "Missing required fields" });
  }

  try {
    // Confirm user exists
    const user = await User.findOne({ telegramId });
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    const amt = Number(amount);

    // Validate minimum withdrawal amount
    if (amt < 50) {
      return res.status(400).json({ message: "Minimum withdrawal amount is 50 ETB" });
    }

    // Check user balance
    if (user.balance < amt) {
      return res.status(400).json({ message: "Insufficient balance for withdrawal" });
    }

    // Save withdrawal request as pending
    const withdrawal = new Withdrawal({
      telegramId,
      tx_ref: reference,
      bank_code,
      account_name,
      account_number,
      amount: amt,
      currency,
      status: "pending",
    });

    await withdrawal.save();

    // Send transfer request to Chapa
    const chapaRes = await axios.post(
      "https://api.chapa.co/v1/transfers",
      {
        account_name,
        account_number,
        bank_code,
        amount: amt,
        currency,
        reference,
      },
      {
        headers: {
          Authorization: `Bearer ${CHAPA_SECRET_KEY}`,
          "Content-Type": "application/json",
        },
      }
    );

    console.log("✅ Chapa transfer response:", chapaRes.data);

    return res.status(200).json({
      message: "Withdrawal request sent to Chapa",
      chapa: chapaRes.data,
      tx_ref: reference,
    });
  } catch (err) {
    console.error("❌ Withdrawal or Chapa error:", err.response?.data || err.message);
    return res.status(500).json({
      message: "Chapa transfer failed",
      chapa: err.response?.data,
    });
  }
});




router.get("/verify/:ref", async (req, res) => {
  const { ref } = req.params;

  try {
    const chapaRes = await axios.get(`https://api.chapa.co/v1/transfers/verify/${ref}`, {
      headers: {
        Authorization: `Bearer ${CHAPA_SECRET_KEY}`,
      },
    });

    const chapaStatus = chapaRes.data?.data?.status;

    // Optionally update DB if status changed to success
    if (chapaStatus === "SUCCESSFUL") {
      await Withdrawal.findOneAndUpdate(
        { tx_ref: ref },
        { status: "success", chapaConfirmed: true }
      );
      return res.json({ status: "success" });
    }

    res.json({ status: "pending" });
  } catch (err) {
    console.error("❌ Error verifying withdrawal:", err.response?.data || err.message);
    res.status(500).json({ status: "error", message: "Could not verify withdrawal" });
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
   

    if (payment && payment.telegramId) {
      // ✅ Update user's balance
      const user = await User.findOneAndUpdate(
        { telegramId: payment.telegramId },
        { $inc: { balance: Number(amount) } }, // Make sure balance is a Number in schema
        { new: true }
      );

  // ✅ Update Redis with the new balance
      await redis.set(`userBalance:${payment.telegramId}`, user.balance.toString());

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
