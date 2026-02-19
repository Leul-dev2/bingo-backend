const crypto = require("crypto");

function verifyTelegramInitData(initDataRaw, botToken) {
  if (!initDataRaw || typeof initDataRaw !== "string") {
    console.warn("Invalid initData: not a string or empty");
    return null;
  }

  if (!botToken || typeof botToken !== "string" || botToken.trim() === "") {
    console.error("Invalid or missing bot token");
    return null;
  }

  try {
    const params = new URLSearchParams(initDataRaw);

    // Telegram sometimes uses "hash", sometimes "signature" in different contexts
    const telegramHash = params.get("hash") || params.get("signature");
    if (!telegramHash) {
      console.warn("Missing hash/signature in initData");
      return null;
    }

    // Collect all parameters except hash/signature
    const checkParams = {};
    for (const [key, value] of params.entries()) {
      if (key !== "hash" && key !== "signature") {
        checkParams[key] = value;
      }
    }

    // Sort keys alphabetically (very important!)
    const sortedKeys = Object.keys(checkParams).sort((a, b) => a.localeCompare(b));

    // Build data-check-string exactly as Telegram expects
    const dataCheckString = sortedKeys
      .map((key) => `${key}=${checkParams[key]}`)
      .join("\n");

    console.log("[Verification] dataCheckString:\n" + dataCheckString);

    // === CORRECT SECRET KEY GENERATION FOR MINI APPS ===
    const secretKey = crypto
      .createHmac("sha256", "WebAppData")
      .update(botToken)
      .digest();

    // Compute HMAC
    const computedHash = crypto
      .createHmac("sha256", secretKey)
      .update(dataCheckString)
      .digest("hex");

    console.log("[Verification] computedHash:", computedHash);
    console.log("[Verification] received hash  :", telegramHash);

    // Constant-time comparison (security best practice)
    const isValid = crypto.timingSafeEqual(
      Buffer.from(computedHash, "hex"),
      Buffer.from(telegramHash, "hex")
    );

    if (!isValid) {
      console.warn("❌ Telegram init data verification FAILED");
      return null;
    }

    // Optional: reject very old data (recommended)
    const authDateStr = params.get("auth_date");
    if (authDateStr) {
      const authDate = parseInt(authDateStr, 10);
      const now = Math.floor(Date.now() / 1000);
      if (now - authDate > 86400) { // 24 hours
        console.warn(`Init data too old (auth_date=${authDate}, age=${now - authDate}s)`);
        return null;
      }
    }

    // Parse user object
    const userJson = params.get("user");
    if (!userJson) {
      console.warn("Missing user field");
      return null;
    }

    let user;
    try {
      user = JSON.parse(userJson);
    } catch (e) {
      console.error("Failed to parse user JSON:", e.message);
      return null;
    }

    return {
      telegramId: String(user.id),
      username: user.username || "",
      firstName: user.first_name || "",
      lastName: user.last_name || "",
      fullName: `${user.first_name || ""} ${user.last_name || ""}`.trim(),
      photoUrl: user.photo_url || null,
      languageCode: user.language_code || "en",
      allowsWriteToPm: !!user.allows_write_to_pm,
      // You can add more fields if needed: is_premium, added_by, etc.
    };

  } catch (err) {
    console.error("[Verification] Error:", err.message, err.stack);
    return null;
  }
}

module.exports = { verifyTelegramInitData };