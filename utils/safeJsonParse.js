 // A helper function for safe JSON parsing
    const safeJsonParse = (rawPayload, key, socketId) => {
        try {
            if (rawPayload) {
                return JSON.parse(rawPayload);
            }
        } catch (e) {
            console.error(`❌ Error parsing payload for ${key} and socket ${socketId}: ${e.message}. Cleaning up.`);
        }
        return null;
    };

    module.exports = { safeJsonParse };