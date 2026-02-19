const crypto = require("crypto");

function verifyTelegramInitData(initDataRaw, botToken) {
  if (!initDataRaw) return null;

  try {
    const params = new URLSearchParams(initDataRaw);

    const hash = params.get("hash");
    const authDate = params.get("auth_date");

    if (!hash || !authDate) return null;

    // 🔐 Replay protection
    const MAX_AGE_SECONDS = 300;
    const now = Math.floor(Date.now() / 1000);
    const age = now - Number(authDate);

    if (age > MAX_AGE_SECONDS) {
      console.warn("❌ initData expired");
      return null;
    }

    params.delete("hash");

    const keys = Array.from(params.keys()).sort();

    const dataCheckString = keys
      .map((key) => `${key}=${params.get(key)}`)
      .join("\n");

    const secretKey = crypto
      .createHmac("sha256", "WebAppData")
      .update(botToken.trim())
      .digest();

    const computedHash = crypto
      .createHmac("sha256", secretKey)
      .update(dataCheckString)
      .digest("hex");

    if (computedHash !== hash) {
      console.warn("❌ Hash mismatch");
      return null;
    }

    const user = JSON.parse(params.get("user"));

    return {
      telegramId: String(user.id),
      username: user.username,
      first_name: user.first_name,
    };

  } catch (e) {
    console.error("Verification error:", e);
    return null;
  }
}

module.exports = { verifyTelegramInitData };
