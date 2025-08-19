const express = require('express');
const router = express.Router();
const SmsMessage = require('../models/SmsMessage');

router.post('/sms-webhook', async (req, res) => {
  try {
    console.log("📩 Incoming webhook:", req.body);

    // Try to normalize the payload (support multiple apps)
    const from =
      req.body.from || req.body.sender || req.body.address || req.body.phone;

    const message =
      req.body.message || req.body.content || req.body.body || req.body.text;

    const sent_timestamp =
      req.body.sent_timestamp || req.body.timestamp || req.body.time;

    const gateway = req.body.gateway || "default";

    // Validation
    if (!from || !message) {
      console.error('❌ Invalid payload: Missing "from" or "message".', req.body);
      return res
        .status(400)
        .send({ message: 'Invalid payload: Missing from or message.' });
    }

    // Save SMS
    const newSms = new SmsMessage({
      from,
      message,
      timestamp: sent_timestamp ? new Date(sent_timestamp) : Date.now(),
      gateway,
    });

    await newSms.save();
    console.log(`✅ SMS from ${from} saved successfully.`);

    // Confirm to the app
    return res
      .status(200)
      .send({ message: 'SMS received and processed successfully' });
  } catch (error) {
    console.error('❌ Error processing SMS webhook:', error);
    return res.status(500).send({ message: 'Internal Server Error' });
  }
});

module.exports = router;
