// routes/sms.js
const express = require('express');
const router = express.Router();
const SmsMessage = require('../models/SmsMessage');

router.post('/sms-webhook', async (req, res) => {
  try {
    console.log("📩 Incoming webhook:", req.body);

    let from = '';
    let message = '';
    let sent_timestamp = '';
    let gateway = (req.body.gateway || "default").trim();

    // Auto-detect payload format
    if (req.body.key) {
      // Handles "From : +251930534417\nGMDxhjfssfh" format
      const parts = req.body.key.split('\n');
      if (parts.length > 0) {
        from = parts[0].replace(/From\s*:\s*/, '').trim();
        // Joins all remaining parts to handle multi-line messages
        message = parts.slice(1).join('\n').trim();
      }
      sent_timestamp = req.body.time || req.body.sent_timestamp;
    } else {
      // Standard JSON payload
      from = req.body.from || req.body.sender || req.body.address || req.body.phone || '';
      message = req.body.message || req.body.content || req.body.body || req.body.text || '';
      sent_timestamp = req.body.sent_timestamp || req.body.timestamp || req.body.time;
    }

    // Validation
    if (!from || !message) {
      console.error('❌ Invalid payload: Missing "from" or "message".', req.body);
      return res.status(400).send({ message: 'Invalid payload: Missing from or message.' });
    }

    // Parse timestamp safely
    let timestamp = Date.now();
    if (sent_timestamp) {
      const parsedTime = Date.parse(sent_timestamp);
      timestamp = isNaN(parsedTime) ? Date.now() : parsedTime;
    }

    // Save SMS to MongoDB
    // The "status" field will automatically default to "pending" as per your schema
    const newSms = new SmsMessage({
      from,
      message,
      timestamp,
      gateway,
    });

    await newSms.save();
    console.log(`✅ SMS from ${from} saved successfully.`);

    // Respond to sender app
    return res.status(200).send({ message: 'SMS received and processed successfully' });
  } catch (error) {
    console.error('❌ Error processing SMS webhook:', error);
    return res.status(500).send({ message: 'Internal Server Error' });
  }
});

module.exports = router;