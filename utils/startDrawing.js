 const { getGameDrawStateKey, getGameDrawsKey, getGameRoomsKey } = require("./redisKeys");
 const { resetRound } = require("./resetRound");
 
 
 async function startDrawing(gameId, GameSessionId, io, state, redis, socket) { // Ensuring socket is present for resetRound
        const strGameId = String(gameId);
        const strGameSessionId = String(GameSessionId);
        const gameDrawStateKey = getGameDrawStateKey(strGameSessionId);
        const gameDrawsKey = getGameDrawsKey(strGameSessionId);
        const gameRoomsKey = getGameRoomsKey(strGameId);

        // Define the required variable delays
        const DRAW_INITIAL_DELAY = 2000; // 2 seconds for the first number
        const DRAW_SUBSEQUENT_DELAY = 4000; // 4 seconds for all numbers after the first

        if (state.drawIntervals[strGameId]) {
            console.log(`⛔️ Drawing already in progress for game ${strGameId}, skipping.`);
            return;
        }

        console.log(`🎯 Starting the drawing process for gameId: ${strGameId}. First draw in ${DRAW_INITIAL_DELAY/1000}s, then every ${DRAW_SUBSEQUENT_DELAY/1000}s.`);
        await redis.del(gameDrawsKey);

        const drawNextNumber = async () => {
            try {
                const currentPlayersInRoom = (await redis.sCard(gameRoomsKey)) || 0;

                // --- STOP CONDITION: NO PLAYERS ---
                if (currentPlayersInRoom === 0) {
                    console.log(`🛑 No players left. Stopping drawing and initiating round reset.`);
                    // Clean up the recurring timer
                    clearInterval(state.drawIntervals[strGameId]);
                    delete state.drawIntervals[strGameId];
                    await resetRound(strGameId, GameSessionId, socket, io, state, redis);
                    io.to(strGameId).emit("gameEnded", { message: "Game ended due to all players leaving the room." });
                    return;
                }

                // Read game state from Redis
                const gameDataRaw = await redis.get(gameDrawStateKey);
                if (!gameDataRaw) {
                    console.log(`❌ No game draw data found for ${strGameId}. Stopping draw.`);
                    clearInterval(state.drawIntervals[strGameId]);
                    delete state.drawIntervals[strGameId];
                    return;
                }

                const gameData = JSON.parse(gameDataRaw);

                // --- STOP CONDITION: ALL NUMBERS DRAWN ---
                if (gameData.index >= gameData.numbers.length) {
                    console.log(`🎯 All numbers drawn for game ${strGameId}`);
                    clearInterval(state.drawIntervals[strGameId]);
                    delete state.drawIntervals[strGameId];
                    io.to(strGameId).emit("allNumbersDrawn", { gameId: strGameId });
                    await resetRound(strGameId, GameSessionId, socket, io, state, redis);
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
                await resetRound(strGameId, GameSessionId, socket, io, state, redis);
                io.to(strGameId).emit("gameEnded", { gameId: strGameId, message: "Game ended due to drawing error." });
            }
        };

        // 🕑 Draw the first number after the initial delay (2 seconds)
        setTimeout(async () => {
            await drawNextNumber(); // Draw the first number

            // 🕓 Then start the recurring interval (4 seconds)
            // Store the ID of the setInterval so it can be cleared by drawNextNumber or other handlers
            state.drawIntervals[strGameId] = setInterval(async () => {
                await drawNextNumber();
            }, DRAW_SUBSEQUENT_DELAY);

        }, DRAW_INITIAL_DELAY);
    }


    module.exports = { startDrawing };