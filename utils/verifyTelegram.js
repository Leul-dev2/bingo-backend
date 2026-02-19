const crypto = require("crypto");

function verifyTelegramInitData(initData, botToken) {
    if (!initData || typeof initData !== "string") {
        console.warn("Invalid initData format. Expected non-empty string.");
        return null;
    }

    try {
        // 1️⃣ Decode URL-encoded initData (in case it comes from URL)
        const decoded = decodeURIComponent(initData);

        // 2️⃣ Convert to key=value pairs
        const params = {};
        decoded.split("&").forEach(pair => {
            const [key, value] = pair.split("=");
            if (key && value !== undefined) {
                params[key] = value;
            }
        });

        // 3️⃣ Extract Telegram hash
        const telegramHash = params.hash;
        if (!telegramHash) return null;

        // 4️⃣ Compute data_check_string
        const checkParams = { ...params };
        delete checkParams.hash;

        // Sort keys alphabetically
        const sortedPairs = Object.entries(checkParams)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, v]) => `${k}=${v}`);

        const dataCheckString = sortedPairs.join("\n");

        // 5️⃣ Compute secret key from bot token
        const secretKey = crypto.createHash("sha256").update(botToken).digest();

        // 6️⃣ Compute HMAC-SHA256 of data_check_string
        const computedHash = crypto
            .createHmac("sha256", secretKey)
            .update(dataCheckString)
            .digest("hex");

        // 7️⃣ Compare hashes securely
        if (!crypto.timingSafeEqual(Buffer.from(computedHash), Buffer.from(telegramHash))) {
            console.warn("❌ Telegram init data verification failed!");
            console.log("dataCheckString:", dataCheckString);
            console.log("computedHash:", computedHash);
            console.log("telegramHash:", telegramHash);
            return null;
        }

        // 8️⃣ Parse user JSON (safe now)
        const user = JSON.parse(decodeURIComponent(params.user));

        return {
            telegramId: String(user.id),
            username: user.username || `${user.first_name} ${user.last_name || ""}`.trim(),
            firstName: user.first_name,
            lastName: user.last_name,
            photoUrl: user.photo_url,
            languageCode: user.language_code,
        };

    } catch (err) {
        console.error("Error verifying Telegram init data:", err);
        return null;
    }
}

module.exports = { verifyTelegramInitData };
