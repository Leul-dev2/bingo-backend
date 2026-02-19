const crypto = require("crypto");

function verifyTelegramInitData(initData, botToken) {
    if (!initData || typeof initData !== "string") {
        console.warn("Invalid initData format. Expected a non-empty string.");
        return null;
    }

    const params = new URLSearchParams(initData);
    const data = {};
    for (const [key, value] of params.entries()) {
        data[key] = value;
    }

    if (!data.user || !data.hash) {
        console.warn("Missing user or hash in initData.");
        return null;
    }

    const hash = data.hash;
    delete data.hash;

    // Parse user JSON
    try {
        data.user = JSON.parse(decodeURIComponent(data.user));
    } catch (err) {
        console.warn("Failed to parse Telegram user JSON:", err);
        return null;
    }

    // Recreate data_check_string
    const sortedPairs = Object.entries(data)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${k}=${v}`);
    const dataCheckString = sortedPairs.join("\n");

    // Compute HMAC SHA256 using bot token
    const secretKey = crypto.createHash("sha256").update(botToken).digest();
    const computedHash = crypto
        .createHmac("sha256", secretKey)
        .update(dataCheckString)
        .digest("hex");

    if (computedHash !== hash) {
        console.warn("❌ Telegram init data verification failed!");
        return null;
    }

    // Return verified Telegram user object
    return {
        telegramId: data.user.id,
        username: data.user.username,
        firstName: data.user.first_name,
        lastName: data.user.last_name || "",
        photoUrl: data.user.photo_url || null,
    };
}


module.exports = { verifyTelegramInitData };
