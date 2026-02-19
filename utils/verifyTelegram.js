const crypto = require("crypto");

function verifyTelegramInitData(initData, botToken) {
    const crypto = require("crypto");

    if (!initData || typeof initData !== "string") return null;

    try {
        // URL decode once
        const decoded = decodeURIComponent(initData);

        const params = {};
        decoded.split("&").forEach(pair => {
            const [key, value] = pair.split("=");
            if (key && value !== undefined) params[key] = value;
        });

        const telegramHash = params.hash;
        if (!telegramHash) return null;

        // Create data_check_string: only remove 'hash', keep everything else exactly
        const checkParams = { ...params };
        delete checkParams.hash;

        const sortedPairs = Object.entries(checkParams)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, v]) => `${k}=${v}`);

        const dataCheckString = sortedPairs.join("\n");

        const secretKey = crypto.createHash("sha256").update(botToken).digest();

        const computedHash = crypto
            .createHmac("sha256", secretKey)
            .update(dataCheckString)
            .digest("hex");

        if (!crypto.timingSafeEqual(Buffer.from(computedHash), Buffer.from(telegramHash))) {
            console.warn("❌ Telegram init data verification failed!");
            console.log("dataCheckString:", dataCheckString);
            console.log("computedHash:", computedHash);
            console.log("telegramHash:", telegramHash);
            return null;
        }

        // Decode user JSON **after** verification
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
        console.error(err);
        return null;
    }
}


module.exports = { verifyTelegramInitData };
