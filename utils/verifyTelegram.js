const crypto = require("crypto");

function verifyTelegramInitData(initDataRaw, botToken) {
    if (!initDataRaw || typeof initDataRaw !== "string") {
        console.warn("Invalid initData format");
        return null;
    }

    try {
        // 1. Do NOT decode twice — Telegram already sends URL-encoded
        const params = new URLSearchParams(initDataRaw);

        const telegramHash = params.get("hash");
        if (!telegramHash) {
            console.warn("No hash field found");
            return null;
        }

        // 2. Collect all params except hash
        const checkParams = {};
        for (const [key, value] of params.entries()) {
            if (key !== "hash") {
                checkParams[key] = value;
            }
        }

        // 3. Sort keys alphabetically
        const sortedKeys = Object.keys(checkParams).sort();

        // 4. Build data-check-string (raw values, no extra encoding)
        const dataCheckString = sortedKeys
            .map(key => `${key}=${checkParams[key]}`)
            .join("\n");

        console.log("dataCheckString:\n" + dataCheckString);

        // 5. Secret = SHA256(botToken)
        const secretKey = crypto.createHash("sha256").update(botToken).digest();

        // 6. HMAC-SHA256(dataCheckString, secret)
        const computedHash = crypto
            .createHmac("sha256", secretKey)
            .update(dataCheckString)
            .digest("hex");

        console.log("computedHash:", computedHash);
        console.log("telegramHash :", telegramHash);

        // 7. Constant-time comparison
        if (!crypto.timingSafeEqual(
            Buffer.from(computedHash, "hex"),
            Buffer.from(telegramHash, "hex")
        )) {
            console.warn("❌ Telegram init data verification failed!");
            return null;
        }

        // 8. Parse user
        const userRaw = params.get("user");
        if (!userRaw) return null;

        const user = JSON.parse(userRaw);

        return {
            telegramId: String(user.id),
            username: user.username || `${user.first_name || ""} ${user.last_name || ""}`.trim(),
            firstName: user.first_name,
            lastName: user.last_name,
            photoUrl: user.photo_url,
            languageCode: user.language_code,
            allowsWriteToPm: user.allows_write_to_pm === true,
        };

    } catch (err) {
        console.error("Verification error:", err);
        return null;
    }
}

module.exports = { verifyTelegramInitData };