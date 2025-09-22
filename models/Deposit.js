const mongoose = require("mongoose");

const DepositSchema = new mongoose.Schema({
    /** * Reference to the User document. This creates a direct link
     * to the user who made the deposit.
     */
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User', // This should match the name of your User model
        required: true,
    },

    /** * The user's unique Telegram ID. Indexed for fast lookups
     * from the dashboard.
     */
    telegramId: {
        type: Number,
        required: true,
        index: true,
    },

    /** The amount of money that was deposited. */
    amount: {
        type: Number,
        required: true,
        min: 0, // Ensures the amount is not negative
    },

    /** The payment method used, e.g., 'CBE' or 'Telebirr'. */
    method: {
        type: String,
        required: true,
        enum: ['CBE', 'Telebirr', 'Other'], // Restricts values for consistency
    },

    /** * The current status of the deposit.
     * - pending:   Awaiting verification.
     * - approved:  Successfully verified and balance credited.
     * - rejected:  Failed verification.
     */
    status: {
        type: String,
        required: true,
        enum: ['pending', 'approved', 'rejected'],
        default: 'pending',
    },

    /** * The unique transaction ID from the SMS (e.g., 'FT...').
     * Making this unique prevents creating two deposit records for the same transaction.
     */
    transactionId: {
        type: String,
        required: true,
        unique: true,
    },

    /** * A direct reference to the SmsMessage document that was used to
     * verify this deposit. This is your "proof of payment".
     */
    smsMessageId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'SmsMessage', // Refers to your SmsMessage model
        required: true,
    },

    /** * Snapshot of the user's balance *before* this deposit was approved.
     * Crucial for fraud analysis.
     */
    balanceBefore: {
        type: Number,
        required: true,
    },

    /** * Snapshot of the user's balance *after* this deposit was approved.
     * Helps you audit and confirm the balance was updated correctly.
     */
    balanceAfter: {
        type: Number,
        required: true,
    },
}, {
    /** * Automatically adds 'createdAt' and 'updatedAt' fields to your documents,
     * so you know when the deposit was requested and when it was finalized.
     */
    timestamps: true
});

module.exports = mongoose.model("Deposit", DepositSchema);