const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');

// Import your Mongoose model
const SmsMessage = require('../models/SmsMessage');

router.post('/sms-webhook', async (req, res) => {
  try {
    console.log("📩 Incoming webhook:", req.body);

    // The payload format from SMSSync or similar apps
    // It's crucial that these field names match the data sent by your app
    const { from, message, sent_timestamp, gateway } = req.body;

    // Check for the required fields
    if (!from || !message) {
      console.error('❌ Invalid payload: Missing "from" or "message".', req.body);
      return res.status(400).send({ message: 'Invalid payload: Missing from or message.' });
    }

    // Create a new document using the SmsMessage model
    const newSms = new SmsMessage({
      from: from,
      message: message,
      // Use the timestamp from the payload, or a new one if it's not provided
      timestamp: sent_timestamp ? new Date(sent_timestamp) : Date.now(),
      gateway: gateway,
    });

    // Save the document to the MongoDB database
    await newSms.save();
    console.log(`✅ SMS from ${from} saved successfully.`);

    // Send a 200 OK response to the gateway app to confirm receipt
    return res.status(200).send({ message: 'SMS received and processed successfully' });

  } catch (error) {
    console.error('❌ Error processing SMS webhook:', error);
    // Send a 500 error response if something went wrong
    return res.status(500).send({ message: 'Internal Server Error' });
  }
});

module.exports = router;