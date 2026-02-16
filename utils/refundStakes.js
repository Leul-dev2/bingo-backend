const User = require("../models/user"); 
const Ledger = require("../models/Ledger");

 
 // Helper to refund all players who were successfully deducted
    async function refundStakes(playerIds, strGameSessionId, stakeAmount, redis) { // stakeAmount is now just a fallback
        for (const playerId of playerIds) {
            try {
                // 1. Find the original deduction record from the ledger
                const deductionRecord = await Ledger.findOne({
                    telegramId: String(playerId),
                    gameSessionId: strGameSessionId,
                    transactionType: { $in: ['stake_deduction', 'bonus_stake_deduction'] }
                });

                let updateQuery;
                let refundTransactionType;
                let wasBonus = false;
                // --- NEW ---: This is the amount we will refund
                let amountToRefund = stakeAmount; // Default fallback

                if (deductionRecord) {
                    // --- FIX ---: Use the actual amount from the ledger
                    amountToRefund = Math.abs(deductionRecord.amount); 
                }

                // 2. Determine which balance to refund based on the record
                if (deductionRecord && deductionRecord.transactionType === 'bonus_stake_deduction') {
                    // Player paid with BONUS, so refund to BONUS balance
                    // --- FIX ---: Use amountToRefund
                    updateQuery = { $inc: { bonus_balance: amountToRefund }, $unset: { reservedForGameId: "" } };
                    refundTransactionType = 'bonus_stake_refund';
                    wasBonus = true;
                    console.log(`Player ${playerId} paid with bonus. Preparing bonus refund.`);
                } else {
                    // Player paid with MAIN, or we couldn't find a record (safe fallback)
                    // --- FIX ---: Use amountToRefund
                    updateQuery = { $inc: { balance: amountToRefund }, $unset: { reservedForGameId: "" } };
                    refundTransactionType = 'stake_refund';
                    if (!deductionRecord) {
                        console.warn(`⚠️ Ledger record not found for player ${playerId}. Defaulting to main balance refund of ${amountToRefund}.`);
                    }
                }

                // 3. Update the user's document with the correct balance refund
                const refundedUser = await User.findOneAndUpdate({ telegramId: playerId }, updateQuery, { new: true });

                if (refundedUser) {
                    // 4. Update the correct balance in Redis cache
                    if (wasBonus) {
                        await redis.set(`userBonusBalance:${playerId}`, refundedUser.bonus_balance.toString(), "EX", 60);
                    } else {
                        await redis.set(`userBalance:${playerId}`, refundedUser.balance.toString(), "EX", 60);
                    }

                    // 5. Create a new ledger entry for the refund transaction
                    await Ledger.create({
                        gameSessionId: strGameSessionId,
                        amount: amountToRefund, // --- FIX ---
                        transactionType: refundTransactionType,
                        telegramId: String(playerId),
                        description: `Stake refund for cancelled game session ${strGameSessionId}`
                    });
                    console.log(`✅ Successfully refunded ${amountToRefund} to ${wasBonus ? 'bonus' : 'main'} balance for player ${playerId}.`);
                } else {
                    console.error(`❌ Could not find user ${playerId} to process refund.`);
                }

            } catch (error) {
                console.error(`❌ Error processing refund for player ${playerId}:`, error);
            }
        }
    }