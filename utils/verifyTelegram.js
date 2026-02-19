const crypto = require("crypto");

function verifyTelegramInitData(initDataRaw, botToken) {
  if (!initDataRaw) return null;

  try {
    const params = new URLSearchParams(initDataRaw);
    const hash = params.get("hash");
    params.delete("hash"); // Remove hash to sort remaining keys

    // 1. Sort the keys alphabetically
    const keys = Array.from(params.keys()).sort();
    
    // 2. Construct the data-check-string exactly as Telegram expects
    // We use the raw value to avoid issues with double-decoding
    const dataCheckString = keys
      .map((key) => `${key}=${params.get(key)}`)
      .join("\n");

    // 3. Create the secret key using the HMAC-SHA256 of the token with "WebAppData"
    const secretKey = crypto
      .createHmac("sha256", "WebAppData")
      .update(botToken.trim())
      .digest();

    // 4. Calculate the hash of the data-check-string
    const computedHash = crypto
      .createHmac("sha256", secretKey)
      .update(dataCheckString)
      .digest("hex");

    console.log("[Verification] dataCheckString:\n", dataCheckString);
    console.log("[Verification] computedHash:", computedHash);
    console.log("[Verification] received hash  :", hash);

    if (computedHash !== hash) {
      console.warn("❌ Telegram init data verification FAILED");
      return null;
    }

    const user = JSON.parse(params.get("user"));
    return { telegramId: String(user.id), ...user };
  } catch (e) {
    console.error("Verification Error:", e);
    return null;
  }
}

module.exports = { verifyTelegramInitData };