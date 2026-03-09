const { getGameDrawStateKey, getGameDrawsKey, getGameRoomsKey } = require("./redisKeys");
const { resetRound } = require("./resetRound");

async function startDrawing(gameId, GameSessionId, io, state, redis) {
    const strGameId = String(gameId);
    const strGameSessionId = String(GameSessionId);
    const gameDrawStateKey = getGameDrawStateKey(strGameSessionId);
    const gameDrawsKey = getGameDrawsKey(strGameSessionId);
    const gameRoomsKey = getGameRoomsKey(strGameId);

    const DRAW_INITIAL_DELAY = 2000;
    const DRAW_SUBSEQUENT_DELAY = 4000;

    // ── Redis-based drawing ownership lock (works across multiple servers) ──
    const drawingLockKey = `lock:drawing:${strGameId}`;
    const lockAcquired = await redis.set(drawingLockKey, "1", { NX: true, EX: 60 });
    if (!lockAcquired) {
        console.log(`⛔️ Drawing already owned by another process for ${strGameId}`);
        return;
    }

    if (state.drawIntervals[strGameId]) {
        console.log(`⛔️ Drawing already in progress (single process check)`);
        await redis.del(drawingLockKey);
        return;
    }

    console.log(`🎯 Starting the drawing process for gameId: ${strGameId}. First draw in ${DRAW_INITIAL_DELAY/1000}s, then every ${DRAW_SUBSEQUENT_DELAY/1000}s.`);
    await redis.del(gameDrawsKey);

    const drawNextNumber = async () => { 
        const strGameId = String(gameId);
        // === NEW: Redis ownership guard + renewal (this replaces memory control) ===
        const stillOwner = await redis.get(drawingLockKey);
        if (!stillOwner) {
            console.log(`⛔ No longer drawing owner for ${strGameId} — stopping`);
            clearInterval(state.drawIntervals[strGameId]);
            delete state.drawIntervals[strGameId];
            return;
        }
        await redis.set(drawingLockKey, "1", { EX: 60 }); // renew every draw

        try {
            const currentPlayersInRoom = (await redis.sCard(gameRoomsKey)) || 0;

            // --- STOP CONDITION: NO PLAYERS ---
            if (currentPlayersInRoom === 0) {
                console.log(`🛑 No players left. Stopping drawing and initiating round reset.`);
                clearInterval(state.drawIntervals[strGameId]);
                delete state.drawIntervals[strGameId];
                await redis.del(drawingLockKey);
                await resetRound(strGameId, GameSessionId, null, io, state, redis);
                io.to(strGameId).emit("gameEnded", { message: "Game ended due to all players leaving the room." });
                return;
            }

            // Read game state from Redis
            const gameDataRaw = await redis.get(gameDrawStateKey);
            if (!gameDataRaw) {
                console.log(`❌ No game draw data found for ${strGameId}. Stopping draw.`);
                clearInterval(state.drawIntervals[strGameId]);
                delete state.drawIntervals[strGameId];
                await redis.del(drawingLockKey);
                return;
            }

            const gameData = JSON.parse(gameDataRaw);

            // --- STOP CONDITION: ALL NUMBERS DRAWN ---
            if (gameData.index >= gameData.numbers.length) {
                console.log(`🎯 All numbers drawn for game ${strGameId}`);
                clearInterval(state.drawIntervals[strGameId]);
                delete state.drawIntervals[strGameId];
                await redis.del(drawingLockKey);
                io.to(strGameId).emit("allNumbersDrawn", { gameId: strGameId });
                await resetRound(strGameId, GameSessionId, null, io, state, redis);
                return;
            }

            // --- DRAW PROCESS ---
            const number = gameData.numbers[gameData.index];
            gameData.index += 1;

            const callNumberLength = await redis.rPush(gameDrawsKey, number.toString());
            gameData.callNumberLength = callNumberLength;
            await redis.set(gameDrawStateKey, JSON.stringify(gameData));

            // Format and emit
            const letter = ["B", "I", "N", "G", "O"][Math.floor((number - 1) / 15)];
            const label = `${letter}-${number}`;
            io.to(strGameId).emit("numberDrawn", { number, label, gameId: strGameId, callNumberLength });
            console.log(`🔢 Drew number: ${label}, Total drawn: ${callNumberLength}`);

        } catch (error) {
            console.error(`❌ Error drawing number for game ${strGameId}:`, error);
            clearInterval(state.drawIntervals[strGameId]);
            delete state.drawIntervals[strGameId];
            await redis.del(drawingLockKey);
            await resetRound(strGameId, GameSessionId, null, io, state, redis);
            io.to(strGameId).emit("gameEnded", { gameId: strGameId, message: "Game ended due to drawing error." });
        }
    };

    // 🕑 Draw the first number after the initial delay
    setTimeout(async () => {
        await drawNextNumber();

        // Then start recurring interval
        state.drawIntervals[strGameId] = setInterval(async () => {
            await drawNextNumber();
        }, DRAW_SUBSEQUENT_DELAY);
    }, DRAW_INITIAL_DELAY);
}

module.exports = { startDrawing };