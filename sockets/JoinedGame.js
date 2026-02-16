 const { pendingDisconnectTimeouts } = require("../utils/timeUtils");
 const GameControl = require("../models/GameControl");
 const PlayerSession = require("../models/PlayerSession");
 const { getGameDrawsKey } = require("../utils/redisKeys"); 
 

   module.exports = function JoinedGameHandler(socket, io, redis) {
    socket.on("joinGame", async ({ gameId, GameSessionId, telegramId, userHeldCardId }) => {
            console.log("joinGame is invoked 🔥🔥🔥");
            try {
                const strGameId = String(gameId);
                const strGameSessionId = String(GameSessionId);
                const strTelegramId = String(telegramId);
                const numTelegramId = Number(telegramId);
                const timeoutKey = `${strTelegramId}:${strGameId}:joinGame`;

                // 1. CRITICAL: Check for and cancel any pending cleanup for this user.
                if (pendingDisconnectTimeouts.has(timeoutKey)) {
                    clearTimeout(pendingDisconnectTimeouts.get(timeoutKey));
                    pendingDisconnectTimeouts.delete(timeoutKey);
                    console.log(`🕒 Player ${strTelegramId} reconnected within the grace period. Cancelling cleanup.`);
                }

                // 2. ROBUST MEMBERSHIP CHECK 
                const playerSessionRecord = await PlayerSession.findOne({ 
                    GameSessionId: strGameSessionId, 
                    telegramId: strTelegramId
                });
                
                if (!playerSessionRecord) {
                    console.warn(`🚫 Blocked user ${strTelegramId}: Player record not found in PlayerSession.`);
                    socket.emit("joinError", { message: "You are not registered in this game session." });
                    return;
                }

                // 3. GAME STATUS CHECK
                const currentGameControl = await GameControl.findOne({ GameSessionId: strGameSessionId });
                
                if (currentGameControl?.endedAt) {
                    console.log(`🔄 Player ${strTelegramId} tried to join a game that has ended.`);
                    const winnerRaw = await redis.get(`winnerInfo:${strGameSessionId}`);
                    if (winnerRaw) {
                        const winnerInfo = JSON.parse(winnerRaw);
                        socket.emit("winnerConfirmed", winnerInfo);
                        console.log(`✅ Redirecting player ${strTelegramId} to winner page.`);
                    } else {
                        socket.emit("gameEnd", { message: "The game has ended." });
                        console.log(`✅ Redirecting player ${strTelegramId} to home page.`);
                    }
                }

                // 4. UPDATE CONNECTION STATUS (Reconnection successful)
                const updatedSession = await PlayerSession.findOneAndUpdate(
                    { _id: playerSessionRecord._id, status: 'disconnected' },
                    { $set: { status: 'connected' } },
                    { new: true }
                );
                
                if (updatedSession) {
                    console.log(`👤 Player ${strTelegramId} reconnected. Status updated to 'connected'.`);
                } else {
                    console.log(`👤 Player ${strTelegramId} was already 'connected' or status was unexpected. Proceeding.`);
                }


                // ----------------------------------------------------
                // ✅ AGGRESSIVE CLEANUP AND CORRECT TTL REGISTRATION
                // ----------------------------------------------------
                
                // 4.5. AGGRESSIVE CLEANUP: Find ALL old activeSocket keys for this user
                const activeSocketKeyPattern = `activeSocket:${strTelegramId}:*`;
                const allKeysForUser = await redis.keys(activeSocketKeyPattern);
                
                const keysToDelete = allKeysForUser.filter(key => !key.endsWith(`:${socket.id}`));
                
                if (keysToDelete.length > 0) {
                    await redis.del(...keysToDelete); 
                    console.log(`🧹 AGGRESSIVELY deleted ${keysToDelete.length} stale activeSocket keys for ${strTelegramId}.`);
                }
                
                // 4.6. CORRECT TTL REGISTRATION: Set the new key with a 2-hour TTL
                const activeSocketKey = `activeSocket:${strTelegramId}:${socket.id}`;
                await redis.set(activeSocketKey, '1', 'EX', 7200); // 7200 seconds = 2 hours
                console.log(`Backend: Socket ${socket.id} for ${strTelegramId} set up with 2hr TTL.`);
                
                // ----------------------------------------------------


                // --- 5. REDIS & SOCKET.IO SETUP (Standard Flow) ---

                // Add to Redis hash for socket tracking (Crucial for disconnect mapping)
                const joinGameSocketInfo = await redis.hSet(`joinGameSocketsInfo`, socket.id, JSON.stringify({
                    telegramId: strTelegramId,
                    gameId: strGameId,
                    GameSessionId: strGameSessionId,
                    phase: 'joinGame'
                }));
                
                // ❌ REMOVED: THE REDUNDANT AND INCORRECT TTL LINE WAS HERE.
                
                // Add user back to the Socket.IO room and Redis room set
                await redis.sAdd(`gameRooms:${strGameId}`, strTelegramId);
                socket.join(strGameId);
                const playerCount = await redis.sCard(`gameRooms:${strGameId}`);
                io.to(strGameId).emit("playerCountUpdate", { gameId: strGameId, playerCount });
                console.log(`[joinGame] Player ${strTelegramId} rejoined game ${strGameId}, total players now: ${playerCount}`);

                // Emit initial session details
                socket.emit("gameId", {
                    gameId: strGameId,
                    GameSessionId: strGameSessionId,
                    telegramId: strTelegramId
                });

                // Send historical drawn numbers if game is active
                const gameDrawsKey = getGameDrawsKey(strGameSessionId);
                const drawnNumbersRaw = await redis.lRange(gameDrawsKey, 0, -1);
                if (drawnNumbersRaw.length > 0) {
                    const drawnNumbers = drawnNumbersRaw.map(Number);
                    const formattedDrawnNumbers = drawnNumbers.map(number => {
                        const letterIndex = Math.floor((number - 1) / 15);
                        const letter = ["B", "I", "N", "G", "O"][letterIndex];
                        return { number, label: `${letter}-${number}` };
                    });
                    socket.emit("drawnNumbersHistory", {
                        gameId: strGameId,
                        GameSessionId: strGameSessionId,
                        history: formattedDrawnNumbers
                    });
                    console.log(`[joinGame] Sent historical drawn numbers to ${strTelegramId}.`);
                }
                
            } catch (err) {
                console.error("❌ Database or Redis error in joinGame:", err);
                socket.emit("joinError", { message: "Failed to join game. Please refresh or retry." });
            }
        });
   }