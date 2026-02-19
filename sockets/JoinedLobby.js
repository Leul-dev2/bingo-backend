const { pendingDisconnectTimeouts, ACTIVE_SOCKET_TTL_SECONDS } = require("../utils/timeUtils");
const { verifyTelegramWithCache } = require("../utils/verifyWithCache");




module.exports = function JoinedLobbyHandler(socket, io, redis) {
     socket.on("userJoinedGame", async ({ initData, gameId }) => {
        console.log("userJoined invoked");
        const verifiedUser = await verifyTelegramWithCache(
            initData,
            process.env.TELEGRAM_BOT_TOKEN,
            redis
        );

    if (!verifiedUser) {
        socket.emit("joinError", {
            message: "Unauthorized user"
        });
        return;
    }

    const strTelegramId = verifiedUser.telegramId;
    const strGameId = String(gameId);
    const multi = redis.multi();

    console.log("✅ Verified Telegram user:", strTelegramId);

        try {
            const userSelectionKey = `userSelections`; // Stores selection per socket.id
            const userOverallSelectionKey = `userSelectionsByTelegramId`; // Stores the user's *overall* selected card by telegramId
            const gameCardsKey = `gameCards:${strGameId}`;
            const userHeldCardsKey = `userHeldCards:${strGameId}:${strTelegramId}`;
            const sessionKey = `gameSessions:${strGameId}`; // Card selection lobby (unique players)
            const gamePlayersKey = `gamePlayers:${strGameId}`; // Overall game players (unique players across all game states)

            console.log(`Backend: Processing userJoinedGame for Telegram ID: ${strTelegramId}, Game ID: ${strGameId}`);

            // --- Step 1: Handle Disconnect Grace Period Timer Cancellation ---
            const timeoutKey = `${strTelegramId}:${strGameId}`;
            if (pendingDisconnectTimeouts.has(timeoutKey)) {
                clearTimeout(pendingDisconnectTimeouts.get(timeoutKey));
                pendingDisconnectTimeouts.delete(timeoutKey);
                console.log(`✅ User ${strTelegramId} reconnected to game ${strGameId} within grace period. Cancelled full disconnect cleanup.`);
            } else {
                console.log(`🆕 User ${strTelegramId} joining game ${strGameId}. No pending disconnect timeout found (or it already expired).`);
            }

            // --- IMPORTANT: Clean up any residual 'joinGame' phase info for this socket ---
            // This handles the transition from 'joinGame' phase to 'lobby' phase for the same socket
            await redis.hDel(`joinGameSocketsInfo`, socket.id);
            console.log(`🧹 Cleaned up residual 'joinGameSocketsInfo' for socket ${socket.id} as it's now in 'lobby' phase.`);


            // --- Step 2: Determine Current Card State for Reconnecting Player ---
            let currentHeldCardId = null;
            let currentHeldCard = null;

            const userOverallSelectionRaw = await redis.hGet(userOverallSelectionKey, strTelegramId);
            if (userOverallSelectionRaw) {
                const overallSelection = JSON.parse(userOverallSelectionRaw);
                if (String(overallSelection.gameId) === strGameId && overallSelection.cardId !== null) {
                    const cardOwner = await redis.sIsMember(userHeldCardsKey, String(overallSelection.cardId));
                    if (cardOwner === strTelegramId) {
                        currentHeldCardId = overallSelection.cardId;
                        currentHeldCard = overallSelection.card;
                        console.log(`✅ User ${strTelegramId} reconnected with previously held card ${currentHeldCardId} for game ${strGameId}.`);
                    } else {
                        console.log(`⚠️ User ${strTelegramId} overall selection for card ${overallSelection.cardId} in game ${strGameId} is no longer valid (card not taken by them in gameCards). Cleaning up stale entry.`);
                        await redis.hDel(userOverallSelectionKey, strTelegramId);
                    }
                } else {
                    console.log(`ℹ️ User ${strTelegramId} had overall selection, but for a different game or no card. No card restored for game ${strGameId}.`);
                }
            } else {
                console.log(`ℹ️ No overall persisted selection found for ${strTelegramId}. User will join without a pre-selected card.`);
            }

            // --- Step 3: Set up new socket and persist its specific selection state ---
            await redis.set(`activeSocket:${strTelegramId}:${socket.id}`, '1', 'EX', ACTIVE_SOCKET_TTL_SECONDS);
            socket.join(strGameId);

            await multi.hSet(userSelectionKey, socket.id, JSON.stringify({
                telegramId: strTelegramId,
                gameId: strGameId,
                cardId: currentHeldCardId,
                card: currentHeldCard,
                phase: 'lobby' // Indicate this socket belongs to the 'lobby' phase
            }));
            console.log(`Backend: Socket ${socket.id} for ${strTelegramId} set up with cardId: ${currentHeldCardId || 'null'} in 'lobby' phase.`);

            // --- Step 4: Add user to Redis Sets (Lobby and Overall Game Players) ---
            await multi.sAdd(sessionKey, strTelegramId);
            await multi.sAdd(gamePlayersKey, strTelegramId);
            console.log(`Backend: Added ${strTelegramId} to Redis SETs: ${sessionKey} and ${gamePlayersKey}.`);

            // --- Step 5: Broadcast Current Lobby State to All Players in the Game ---
            const numberOfPlayersInLobby = await multi.sCard(sessionKey);
            console.log(`Backend: Calculated numberOfPlayers for ${sessionKey} (card selection lobby): ${numberOfPlayersInLobby}`);

            io.to(strGameId).emit("gameid", {
                gameId: strGameId,
                numberOfPlayers: numberOfPlayersInLobby,
            });
            console.log(`Backend: Emitted 'gameid' to room ${strGameId} with numberOfPlayers: ${numberOfPlayersInLobby}`);

            // --- Step 6: Send Initial Card States to the *Joining Client Only* ---
            const allTakenCardsData = await multi.hGetAll(gameCardsKey);
            const initialCardsState = {};
            for (const cardId in allTakenCardsData) {
                initialCardsState[cardId] = {
                    cardId: Number(cardId),
                    takenBy: allTakenCardsData[cardId],
                    isTaken: true
                };
            }
            socket.emit("initialCardStates", { takenCards: initialCardsState });
            console.log(`Backend: Sent 'initialCardStates' to ${strTelegramId} for game ${strGameId}. Total taken cards: ${Object.keys(initialCardsState).length}`);

        } catch (err) {
            console.error("❌ Error in userJoinedGame:", err);
            socket.emit("joinError", {
                message: "Failed to join game. Please refresh or retry.",
            });
        }
    });
}
 
