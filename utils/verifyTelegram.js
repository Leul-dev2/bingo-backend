const crypto = require("crypto");

function verifyTelegramInitData(initData, botToken) {
    
    if (!initData || typeof initData !== "string") return null;

    try {
        // URL decode once
        const decoded = decodeURIComponent(initData);

        // Parse key=value pairs
        const params = {};
        decoded.split("&").forEach(pair => {
            const [key, value] = pair.split("=");
            if (key && value !== undefined) params[key] = value;
        });

        const telegramHash = params.hash;
        if (!telegramHash) return null;

        // Remove hash only
        const checkParams = { ...params };
        delete checkParams.hash;

        // Sort keys alphabetically
        const sortedPairs = Object.entries(checkParams)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, v]) => `${k}=${v}`);

        const dataCheckString = sortedPairs.join("\n");
        console.log("dataCheckString:", dataCheckString); // Should include all 4 keys

        const secretKey = crypto.createHash("sha256").update(botToken).digest();
        const computedHash = crypto
            .createHmac("sha256", secretKey)
            .update(dataCheckString)
            .digest("hex");

        if (!crypto.timingSafeEqual(Buffer.from(computedHash, "hex"), Buffer.from(telegramHash, "hex"))) {
            console.warn("❌ Telegram init data verification failed!");
            console.log("computedHash:", computedHash);
            console.log("telegramHash:", telegramHash);
            return null;
        }

        const user = JSON.parse(params.user);
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
