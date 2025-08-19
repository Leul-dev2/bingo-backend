const express = require('express');
const router = express.Router();
const SmsMessage = require('../models/SmsMessage');
const sanitizeHtml = require('sanitize-html');

// POST /api/sms-webhook
router.post('/sms-webhook', async (req, res) => {
  try {
    const gateway = (req.body.gateway || 'default').trim();
    let from = '';
    let message = '';
    let sentTimestamp = '';

    // Detect payload format
    if (req.body.key) {
      const parts = req.body.key.split('\n');
      from = parts[0]?.replace(/From\s*:\s*/, '').trim() || '';
      message = parts.slice(1).join('\n').trim();
      sentTimestamp = req.body.time || req.body.sent_timestamp;
    } else {
      from = req.body.from || req.body.sender || req.body.address || req.body.phone || '';
      message = req.body.message || req.body.content || req.body.body || req.body.text || '';
      sentTimestamp = req.body.sent_timestamp || req.body.timestamp || req.body.time;
    }

    if (!from || !message) {
      return res.status(400).json({ success: false, error: 'Missing from or message' });
    }

    const cleanMessage = sanitizeHtml(message);

    let timestamp = Date.now();
    if (sentTimestamp) {
      const parsedTime = Date.parse(sentTimestamp);
      timestamp = isNaN(parsedTime) ? Date.now() : parsedTime;
    }

    const newSms = new SmsMessage({ from, message: cleanMessage, timestamp, gateway });
    await newSms.save();

    console.log(`✅ SMS from ${from} saved.`);

    return res.status(200).json({ success: true, message: 'SMS saved', data: { from, message: cleanMessage, timestamp, gateway } });
  } catch (err) {
    console.error('❌ Error processing SMS:', err);
    return res.status(500).json({ success: false, error: 'Internal Server Error' });
  }
});

module.exports = router;
