const crypto = require("crypto");

function verifyTelegramInitData(initData, botToken) {
    const params = new URLSearchParams(initData);

    const hash = params.get("hash");
    params.delete("hash");

    // Sort keys alphabetically
    const dataCheckString = [...params.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, value]) => `${key}=${value}`)
        .join("\n");

    // Create secret key
    const secretKey = crypto
        .createHmac("sha256", "WebAppData")
        .update(botToken)
        .digest();

    // Create HMAC hash
    const calculatedHash = crypto
        .createHmac("sha256", secretKey)
        .update(dataCheckString)
        .digest("hex");

    if (calculatedHash !== hash) {
        return null;
    }

    // Extract user info safely
    const user = JSON.parse(params.get("user"));

    return {
        telegramId: String(user.id),
        username: user.username,
        firstName: user.first_name
    };
}

module.exports = { verifyTelegramInitData };
