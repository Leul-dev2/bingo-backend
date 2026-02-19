const crypto = require("crypto");

function verifyTelegramInitData(initDataRaw, botToken) {
  if (!initDataRaw) return null;

  try {
    const params = new URLSearchParams(initDataRaw);
    const hash = params.get("hash");
    if (!hash) return null;

    params.delete("hash");

    const keys = Array.from(params.keys()).sort();

    const dataCheckString = keys
      .map((key) => `${key}=${params.get(key)}`)
      .join("\n");

    const secretKey = crypto
      .createHmac("sha256", "WebAppData")
      .update(botToken)
      .digest();

    const computedHash = crypto
      .createHmac("sha256", secretKey)
      .update(dataCheckString)
      .digest("hex");

    if (
      !crypto.timingSafeEqual(
        Buffer.from(computedHash, "hex"),
        Buffer.from(hash, "hex")
      )
    ) {
      console.warn("❌ Telegram init data verification FAILED");
      return null;
    }

    // ✅ Expiration check (VERY IMPORTANT)
    const authDate = Number(params.get("auth_date"));
    const now = Math.floor(Date.now() / 1000);

    if (!authDate || now - authDate > 86400) {
      console.warn("❌ Telegram initData expired");
      return null;
    }

    const user = JSON.parse(params.get("user"));

    return {
      telegramId: String(user.id),
      username: user.username || "",
      firstName: user.first_name,
      lastName: user.last_name,
      photoUrl: user.photo_url,
    };
  } catch (err) {
    console.error("Verification error:", err);
    return null;
  }
}

module.exports = { verifyTelegramInitData };
