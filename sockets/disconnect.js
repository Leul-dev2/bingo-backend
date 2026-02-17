   const { safeJsonParse } = require("../utils/safeJsonParse");
   const ACTIVE_DISCONNECT_GRACE_PERIOD_MS = 2000; // 30 seconds for lobby disconnects
   const JOIN_GAME_GRACE_PERIOD_MS = 2000; // 60 seconds for joinGame disconnects
   const { pendingDisconnectTimeouts } = require("../utils/timeUtils");
   
   module.exports = function disconnectHandler(socket, io, redis) {
   socket.on("disconnect", async (reason) => {
        console.log(`🔴 Client disconnected: ${socket.id}, Reason: ${reason}`);

        try {
            const [userSelectionPayloadRaw, joinGamePayloadRaw] = await redis.multi()
                .hGet("userSelections", socket.id)
                .hGet("joinGameSocketsInfo", socket.id)
                .exec();

            let userPayload = null;
            let disconnectedPhase = null;
            // ✅ CORRECTION: Initialize GameSessionId here to ensure it's captured correctly.
            let strGameSessionId = 'NO_SESSION_ID';

            // ✅ CORRECTION: Prioritize the 'joinGame' payload as it contains the critical GameSessionId.
            if (joinGamePayloadRaw) {
                userPayload = safeJsonParse(joinGamePayloadRaw, "joinGameSocketsInfo", socket.id);
                if (userPayload) {
                    disconnectedPhase = userPayload.phase || 'joinGame';
                    strGameSessionId = userPayload.GameSessionId || strGameSessionId;
                } else {
                    await redis.hDel("joinGameSocketsInfo", socket.id); // Clean up corrupted data
                }
            }
            
            // Fallback to the 'lobby' payload if no 'joinGame' info was found.
            if (!userPayload && userSelectionPayloadRaw) {
                userPayload = safeJsonParse(userSelectionPayloadRaw, "userSelections", socket.id);
                if (userPayload) {
                    disconnectedPhase = userPayload.phase || 'lobby';
                } else {
                    await redis.hDel("userSelections", socket.id); // Clean up corrupted data
                }
            }

            if (!userPayload || !userPayload.telegramId || !userPayload.gameId) {
                console.log("❌ No relevant user session info found for this disconnected socket. Skipping cleanup.");
                return;
            }

            const strTelegramId = String(userPayload.telegramId);
            const strGameId = String(userPayload.gameId);

            console.log(`[DISCONNECT] Processing disconnect for User: ${strTelegramId}, Game: ${strGameId}, Phase: ${disconnectedPhase}, Session: ${strGameSessionId}`);

            await redis.del(`activeSocket:${strTelegramId}:${socket.id}`);

            const allActiveSocketKeysForUser = await redis.keys(`activeSocket:${strTelegramId}:*`);
            if (allActiveSocketKeysForUser.length > 0) {
                 console.log(`[DISCONNECT] User ${strTelegramId} still has other active sockets. No cleanup timer started.`);
                 return; // User has other connections, so no need to start a cleanup timer.
            }
            
            const timeoutKeyForPhase = `${strTelegramId}:${strGameId}:${disconnectedPhase}`;
            if (pendingDisconnectTimeouts.has(timeoutKeyForPhase)) {
                clearTimeout(pendingDisconnectTimeouts.get(timeoutKeyForPhase));
                pendingDisconnectTimeouts.delete(timeoutKeyForPhase);
            }

            let gracePeriodDuration = 0;
            if (disconnectedPhase === 'lobby') {
                gracePeriodDuration = ACTIVE_DISCONNECT_GRACE_PERIOD_MS;
            } else if (disconnectedPhase === 'joinGame') {
                gracePeriodDuration = JOIN_GAME_GRACE_PERIOD_MS;
            }

            if (gracePeriodDuration > 0) {
                const timeoutId = setTimeout(async () => {
                    try {
                        const cleanupJob = JSON.stringify({
                            telegramId: strTelegramId,
                            gameId: strGameId,
                            gameSessionId: strGameSessionId, // ✅ CORRECTION: This is now reliably sourced
                            phase: disconnectedPhase,
                            timestamp: new Date().toISOString()
                        });

                        await redis.lPush('disconnect-cleanup-queue', cleanupJob);
                        console.log(`[DEFERRED] Pushed cleanup job to queue for User: ${strTelegramId}, Phase: ${disconnectedPhase}`);

                    } catch (e) {
                        console.error(`❌ Error pushing disconnect job to queue for ${strTelegramId}:`, e);
                    } finally {
                        pendingDisconnectTimeouts.delete(timeoutKeyForPhase);
                    }
                }, gracePeriodDuration);

                pendingDisconnectTimeouts.set(timeoutKeyForPhase, timeoutId);
                console.log(`🕒 Starting ${gracePeriodDuration / 1000}s grace period for ${strTelegramId} in phase '${disconnectedPhase}'.`);
            }
        } catch (e) {
            console.error(`❌ CRITICAL ERROR in disconnect handler for socket ${socket.id}:`, e);
        }
    });

   }

 