const User = require("../models/user");
const GameControl = require("../models/GameControl");
const GameHistory = require("../models/GameHistory")
const resetGame = require("../utils/resetGame");
const checkAndResetIfEmpty = require("../utils/checkandreset");
const redis = require("../utils/redisClient");
const syncGameIsActive = require("../utils/syncGameIsActive");
const GameCard = require('../models/GameCard'); // Your Mongoose models
const checkBingoPattern = require("../utils/BingoPatterns")
const resetRound = require("../utils/resetRound");
const clearGameSessions = require('../utils/clearGameSessions'); // Adjust path as needed
const {
    getGameActiveKey,
    getCountdownKey,
    getActiveDrawLockKey,
    getGameDrawStateKey,
    getGameDrawsKey,
    getGameSessionsKey,
    getGamePlayersKey,
    getGameRoomsKey,
    getCardsKey,
} = require("../utils/redisKeys");

// --- NEW: Contextual Grace Period Configuration ---
const GRACE_PERIODS = {
    CARD_SELECTION: 10 * 1000, // 10 seconds for lobby activity (adjust as needed)
    GAME_PAGE: 20 * 1000,     // 20 seconds for in-game activity (adjust as needed)
    DEFAULT: 5 * 1000         // Default if context is not specified
};

function getGracePeriodForContext(context) {
    return GRACE_PERIODS[context] || GRACE_PERIODS.DEFAULT;
}

// Map to track timeouts for grace period disconnects (key: `${telegramId}:${gameId}`, Value: setTimeout ID)
const pendingDisconnectTimeouts = new Map();

// Map to track last activity timestamp for players in a game (for proactive inactivity checks)
// Key: `${gameId}-${telegramId}`, Value: timestamp (Date.now())
const activeGamePlayersTimestamps = new Map();

// Configuration for proactive inactivity checks
const INACTIVITY_CHECK_INTERVAL_MS = 10 * 1000; // Check for inactivity every 10 seconds (adjust as needed)

const { v4: uuidv4 } = require("uuid"); // Move this up

module.exports = function registerGameSocket(io) {
    // These in-memory stores are used to manage immediate state for the current process.
    // Redis is the source of truth for persistence across processes.
    let gameSessions = {}; // Store game sessions: gameId -> [telegramId]
    let gameSessionIds = {};
    let userSelections = {}; // Store user selections: socket.id -> { telegramId, gameId }
    let gameCards = {}; // Store game card selections: gameId -> { cardId: telegramId }
    const gameDraws = {}; // { [gameId]: { numbers: [...], index: 0 } };
    const countdownIntervals = {}; // { gameId: intervalId }
    const drawIntervals = {}; // { gameId: intervalId }
    const activeDrawLocks = {}; // Prevents multiple starts
    const gameReadyToStart = {};
    let drawStartTimeouts = {};
    const gameIsActive = {};
    const gamePlayers = {};
    const gameRooms = {};
    const joiningUsers = new Set();


    const state = {
        countdownIntervals,
        drawIntervals,
        drawStartTimeouts,
        activeDrawLocks,
        gameDraws,
        gameSessionIds,
        gameIsActive,
        gameReadyToStart: {},
    };

    /**
     * Helper function to remove a player completely from a game.
     * Centralized cleanup logic.
     * @param {string} gameId
     * @param {string} telegramId
     */
    async function removePlayerFromGame(gameId, telegramId) {
        const strGameId = String(gameId);
        const strTelegramId = String(telegramId);
        console.log(`🧹 Attempting to remove player ${strTelegramId} from game ${strGameId}.`);

        try {
            // Remove from gameRooms (active players in the game UI)
            await redis.sRem(getGameRoomsKey(strGameId), strTelegramId);
            console.log(`Removed ${strTelegramId} from ${getGameRoomsKey(strGameId)}.`);

            // Remove from gameSessions (players in card selection lobby)
            await redis.sRem(getGameSessionsKey(strGameId), strTelegramId);
            console.log(`Removed ${strTelegramId} from ${getGameSessionsKey(strGameId)}.`);

            // Remove from overall gamePlayers (all players ever involved in the game)
            await redis.sRem(getGamePlayersKey(strGameId), strTelegramId);
            console.log(`Removed ${strTelegramId} from ${getGamePlayersKey(strGameId)}.`);

            // Clear their selected card from gameCards and DB if they held one for this game
            const userOverallSelectionKey = `userSelectionsByTelegramId`;
            const userOverallSelectionRaw = await redis.hGet(userOverallSelectionKey, strTelegramId);

            if (userOverallSelectionRaw) {
                const overallSelection = JSON.parse(userOverallSelectionRaw);
                if (String(overallSelection.gameId) === strGameId && overallSelection.cardId !== null) {
                    const strCardId = String(overallSelection.cardId);
                    // Check if they are still the owner of the card in Redis
                    const currentCardOwner = await redis.hGet(`gameCards:${strGameId}`, strCardId);
                    if (currentCardOwner === strTelegramId) {
                        await redis.hDel(`gameCards:${strGameId}`, strCardId);
                        await GameCard.findOneAndUpdate(
                            { gameId: strGameId, cardId: Number(strCardId), isTaken: true, takenBy: strTelegramId },
                            { isTaken: false, takenBy: null }
                        );
                        io.to(strGameId).emit("cardAvailable", { cardId: strCardId });
                        console.log(`Card ${strCardId} released and broadcast as available.`);
                    } else {
                        console.log(`Card ${strCardId} was no longer owned by ${strTelegramId}. Skipping release.`);
                    }
                }
                // Clear the user's overall selected card for this game (or any game)
                await redis.hDel(userOverallSelectionKey, strTelegramId);
                console.log(`Cleared overall card selection for ${strTelegramId}.`);
            } else {
                console.log(`No overall card selection found for ${strTelegramId}.`);
            }

            // --- NEW: Remove from activeGamePlayersTimestamps (proactive check) ---
            activeGamePlayersTimestamps.delete(`${strGameId}-${strTelegramId}`);
            console.log(`Removed ${strGameId}-${strTelegramId} from activeGamePlayersTimestamps.`);

            // Clear any pending disconnect timeout for this user/game if it exists
            const timeoutKey = `${strTelegramId}:${strGameId}`;
            if (pendingDisconnectTimeouts.has(timeoutKey)) {
                clearTimeout(pendingDisconnectTimeouts.get(timeoutKey));
                pendingDisconnectTimeouts.delete(timeoutKey);
                console.log(`Cancelled pending disconnect cleanup for ${timeoutKey} due to full removal.`);
            }

            // Update player counts in game room
            const currentPlayersInRoom = await redis.sCard(getGameRoomsKey(strGameId));
            io.to(strGameId).emit("playerCountUpdate", {
                gameId: strGameId,
                playerCount: currentPlayersInRoom,
            });
            console.log(`Player count for ${strGameId} updated to ${currentPlayersInRoom}.`);

            // Check if game room is empty and reset if necessary
            await checkAndResetIfEmpty(strGameId, io, state, redis);
            console.log(`Finished removePlayerFromGame for ${strTelegramId} from ${strGameId}.`);

        } catch (error) {
            console.error(`❌ Error removing player ${strTelegramId} from game ${strGameId}:`, error);
        }
    }


    /**
     * Schedules a disconnect cleanup for a user if they don't reconnect within the grace period.
     * @param {string} telegramId
     * @param {string} gameId
     * @param {string} context - 'CARD_SELECTION', 'GAME_PAGE', or 'DEFAULT'
     */
    function scheduleDisconnectCleanup({ telegramId, gameId, context }) {
        const key = `${telegramId}:${gameId}`;

        // Clear any existing timeout for this user in this game
        clearTimeout(pendingDisconnectTimeouts.get(key));

        const graceTime = getGracePeriodForContext(context);
        console.log(`Scheduling disconnect cleanup for ${key} in ${graceTime}ms (context: ${context}).`);

        const timeoutId = setTimeout(async () => {
            console.log(`🗑️ Grace period ended for ${key}. Performing full cleanup.`);
            await removePlayerFromGame(gameId, telegramId);
            pendingDisconnectTimeouts.delete(key); // Remove from map after execution
        }, graceTime);

        pendingDisconnectTimeouts.set(key, timeoutId);
    }

    /**
     * Refreshes the activity timestamp for a user and cancels any pending disconnect cleanup.
     * This should be called on any relevant client activity.
     * @param {string} telegramId
     * @param {string} gameId
     * @param {string} context - 'CARD_SELECTION', 'GAME_PAGE', or 'DEFAULT'
     */
    function refreshActivityAndCancelCleanup({ telegramId, gameId, context }) {
        const activityKey = `${String(gameId)}-${String(telegramId)}`; // Use gameId-telegramId for activity timestamps
        activeGamePlayersTimestamps.set(activityKey, Date.now());
        // console.log(`Activity ping for ${activityKey}, timestamp updated.`); // Uncomment for verbose logging

        // If there was a pending disconnect timeout, clear it because the user is active again.
        const disconnectKey = `${String(telegramId)}:${String(gameId)}`; // Use telegramId:gameId for disconnect timeouts
        if (pendingDisconnectTimeouts.has(disconnectKey)) {
            clearTimeout(pendingDisconnectTimeouts.get(disconnectKey));
            pendingDisconnectTimeouts.delete(disconnectKey);
            console.log(`✅ User ${disconnectKey} active again. Cancelled pending disconnect cleanup.`);
        }
    }

    // --- Proactive Inactivity Check Loop ---
    setInterval(() => {
        const now = Date.now();
        activeGamePlayersTimestamps.forEach((lastActivity, key) => {
            const [gameId, telegramId] = key.split('-');
            // Use the longest grace period as a threshold for proactive checks,
            // as this is a general "are they gone?" check, not a specific context.
            const effectiveGracePeriod = GRACE_PERIODS.GAME_PAGE + (5 * 1000); // Give a bit more buffer

            if (now - lastActivity > effectiveGracePeriod) {
                console.warn(`🚨 Player ${telegramId} in game ${gameId} detected as inactive. Initiating removal.`);
                removePlayerFromGame(gameId, telegramId); // Call your existing removal function
            }
        });
    }, INACTIVITY_CHECK_INTERVAL_MS);


    io.on("connection", (socket) => {
        console.log("🟢 New client connected");
        console.log("Client connected with socket ID:", socket.id);

        // User joins a game (Lobby/Card Selection Page)
        socket.on("userJoinedGame", async ({ telegramId, gameId, context }) => { // Add context here
            console.log("userJoined invoked");
            const strGameId = String(gameId);
            const strTelegramId = String(telegramId);
            const userContext = context || 'CARD_SELECTION'; // Default to card selection if not provided

            try {
                const userSelectionKey = `userSelections`;
                const userOverallSelectionKey = `userSelectionsByTelegramId`;
                const gameCardsKey = `gameCards:${strGameId}`;
                const sessionKey = getGameSessionsKey(strGameId); // Use getter
                const gamePlayersKey = getGamePlayersKey(strGameId); // Use getter

                console.log(`Backend: Processing userJoinedGame for Telegram ID: ${strTelegramId}, Game ID: ${strGameId}`);

                // --- NEW: Refresh activity and cancel any pending disconnect cleanup ---
                refreshActivityAndCancelCleanup({ telegramId: strTelegramId, gameId: strGameId, context: userContext });


                // --- Step 2: Determine Current Card State for Reconnecting Player ---
                let currentHeldCardId = null;
                let currentHeldCard = null;

                const userOverallSelectionRaw = await redis.hGet(userOverallSelectionKey, strTelegramId);
                if (userOverallSelectionRaw) {
                    const overallSelection = JSON.parse(userOverallSelectionRaw);
                    if (String(overallSelection.gameId) === strGameId && overallSelection.cardId !== null) {
                        const cardOwner = await redis.hGet(gameCardsKey, String(overallSelection.cardId));
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
                // NEW: Use the updated key format for active sockets
                await redis.set(`activeSocket:${strTelegramId}:${strGameId}:${socket.id}`, '1');
                socket.join(strGameId);

                await redis.hSet(userSelectionKey, socket.id, JSON.stringify({
                    telegramId: strTelegramId,
                    gameId: strGameId,
                    cardId: currentHeldCardId,
                    card: currentHeldCard
                }));
                console.log(`Backend: Socket ${socket.id} for ${strTelegramId} set up with cardId: ${currentHeldCardId || 'null'}.`);

                // --- Step 4: Add user to Redis Sets (Lobby and Overall Game Players) ---
                await redis.sAdd(sessionKey, strTelegramId);
                await redis.sAdd(gamePlayersKey, strTelegramId);
                console.log(`Backend: Added ${strTelegramId} to Redis SETs: ${sessionKey} and ${gamePlayersKey}.`);

                // --- Step 5: Broadcast Current Lobby State to All Players in the Game ---
                const numberOfPlayersInLobby = await redis.sCard(sessionKey);
                console.log(`Backend: Calculated numberOfPlayers for ${sessionKey} (card selection lobby): ${numberOfPlayersInLobby}`);

                io.to(strGameId).emit("gameid", {
                    gameId: strGameId,
                    numberOfPlayers: numberOfPlayersInLobby,
                });
                console.log(`Backend: Emitted 'gameid' to room ${strGameId} with numberOfPlayers: ${numberOfPlayersInLobby}`);


                // --- Step 6: Send Initial Card States to the *Joining Client Only* ---
                const allTakenCardsData = await redis.hGetAll(gameCardsKey);
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

        // --- NEW: Game Activity Ping for keeping connections alive and refreshing grace periods ---
        socket.on("gameActivityPing", ({ telegramId, gameId, context }) => {
            const strGameId = String(gameId);
            const strTelegramId = String(telegramId);
            const userContext = context || 'GAME_PAGE'; // Default to GAME_PAGE for pings

            refreshActivityAndCancelCleanup({ telegramId: strTelegramId, gameId: strGameId, context: userContext });
            // console.log(`Received gameActivityPing from ${telegramId} for game ${gameId} with context ${userContext}`);
        });

        socket.on("cardSelected", async (data) => {
            const { telegramId, cardId, card, gameId } = data;

            const strTelegramId = String(telegramId);
            const strCardId = String(cardId);
            const strGameId = String(gameId);

            // --- NEW: Refresh activity ---
            refreshActivityAndCancelCleanup({ telegramId: strTelegramId, gameId: strGameId, context: 'CARD_SELECTION' });

            const gameCardsKey = `gameCards:${strGameId}`;
            const userSelectionsKey = `userSelections`;
            const lockKey = `lock:card:${strGameId}:${strCardId}`;

            const cleanCard = card.map(row => row.map(c => (c === "FREE" ? 0 : Number(c))));

            try {
                // 1️⃣ Redis Lock
                const lock = await redis.set(lockKey, strTelegramId, "NX", "EX", 30);

                if (!lock) {
                    return socket.emit("cardError", {
                        message: "⛔️ This card is currently being selected by another player. Try another card."
                    });
                }

                // 2️⃣ Double check Redis AND DB ownership
                const [currentRedisOwner, existingCard] = await Promise.all([
                    redis.hGet(gameCardsKey, strCardId),
                    GameCard.findOne({ gameId: strGameId, cardId: Number(strCardId) }),
                ]);

                if ((currentRedisOwner && currentRedisOwner !== strTelegramId) ||
                    (existingCard?.isTaken && existingCard.takenBy !== strTelegramId)) {
                    await redis.del(lockKey);
                    return socket.emit("cardUnavailable", { cardId: strCardId });
                }

                // 3️⃣ Update or Create GameCard
                if (existingCard) {
                    const updateResult = await GameCard.updateOne(
                        {
                            gameId: strGameId,
                            cardId: Number(strCardId),
                            isTaken: false, // Ensure it's not taken by someone else
                        },
                        {
                            $set: {
                                card: cleanCard,
                                isTaken: true,
                                takenBy: strTelegramId,
                            }
                        }
                    );

                    if (updateResult.modifiedCount === 0) {
                        await redis.del(lockKey);
                        return socket.emit("cardUnavailable", { cardId: strCardId });
                    }

                } else {
                    try {
                        await GameCard.create({
                            gameId: strGameId,
                            cardId: Number(strCardId),
                            card: cleanCard,
                            isTaken: true,
                            takenBy: strTelegramId
                        });
                    } catch (err) {
                        if (err.code === 11000) {
                            await redis.del(lockKey);
                            return socket.emit("cardUnavailable", { cardId: strCardId });
                        }
                        throw err;
                    }
                }

                // 4️⃣ Remove previously selected card by this user
                const previousSelectionRaw = await redis.hGet("userSelectionsByTelegramId", strTelegramId);

                if (previousSelectionRaw) {
                    const prev = JSON.parse(previousSelectionRaw);

                    if (prev.cardId && prev.cardId !== strCardId) {
                        await redis.hDel(gameCardsKey, prev.cardId);
                        await GameCard.findOneAndUpdate(
                            { gameId: strGameId, cardId: Number(prev.cardId) },
                            { isTaken: false, takenBy: null }
                        );
                        socket.to(strGameId).emit("cardAvailable", { cardId: prev.cardId });
                    }
                }

                // 5️⃣ Store new selection in Redis
                await redis.hSet(gameCardsKey, strCardId, strTelegramId);
                const selectionData = JSON.stringify({
                    telegramId: strTelegramId,
                    cardId: strCardId,
                    card: cleanCard,
                    gameId: strGameId,
                });

                await redis.hSet(userSelectionsKey, socket.id, selectionData);
                await redis.hSet("userSelectionsByTelegramId", strTelegramId, selectionData);

                // 6️⃣ Emit
                socket.emit("cardConfirmed", { cardId: strCardId, card: cleanCard });
                socket.to(strGameId).emit("otherCardSelected", { telegramId: strTelegramId, cardId: strCardId });

                const updatedSelections = await redis.hGetAll(gameCardsKey);
                io.to(strGameId).emit("currentCardSelections", updatedSelections);

                const numberOfPlayers = await redis.sCard(getGameSessionsKey(strGameId)); // Use getter
                io.to(strGameId).emit("gameid", { gameId: strGameId, numberOfPlayers });

            } catch (err) {
                console.error("❌ cardSelected error:", err);
                socket.emit("cardError", { message: "Card selection failed." });
            } finally {
                await redis.del(lockKey); // 🔓 Always release lock
            }
        });


        socket.on("unselectCardOnLeave", async ({ gameId, telegramId, cardId }) => {
            console.log("unselectCardOnLeave is called");
            console.log("unslected datas ", gameId, telegramId, cardId);

            try {
                const strCardId = String(cardId);
                const strTelegramId = String(telegramId);
                const strGameId = String(gameId);

                const currentCardOwner = await redis.hGet(`gameCards:${strGameId}`, strCardId); // Use strGameId

                if (currentCardOwner === strTelegramId) {
                    await redis.hDel(`gameCards:${strGameId}`, strCardId); // Use strGameId
                    await GameCard.findOneAndUpdate(
                        { gameId: strGameId, cardId: Number(strCardId) }, // Use strGameId
                        { isTaken: false, takenBy: null }
                    );

                    // Clear entries for the specific socket and overall user selection
                    await Promise.all([
                        redis.hDel("userSelections", socket.id),
                        redis.hDel("userSelectionsByTelegramId", strTelegramId),
                        redis.del(`activeSocket:${strTelegramId}:${strGameId}:${socket.id}`), // Use updated key format
                    ]);
                    socket.to(strGameId).emit("cardAvailable", { cardId: strCardId }); // Use strGameId

                    console.log(`🧹🔥🔥🔥🔥 Card ${strCardId} released by ${strTelegramId}`);
                }

                // Explicitly clear pending disconnect timeout on explicit leave
                const disconnectKey = `${strTelegramId}:${strGameId}`;
                if (pendingDisconnectTimeouts.has(disconnectKey)) {
                    clearTimeout(pendingDisconnectTimeouts.get(disconnectKey));
                    pendingDisconnectTimeouts.delete(disconnectKey);
                    console.log(`Cancelled pending disconnect cleanup for ${disconnectKey} due to explicit unselectCardOnLeave.`);
                }


            } catch (err) {
                console.error("unselectCardOnLeave error:", err);
            }
        });


        socket.on("joinGame", async ({ gameId, telegramId }) => {
            const strGameId = String(gameId);
            const strTelegramId = String(telegramId);

            try {
                // Validate user is registered in the game via MongoDB
                const game = await GameControl.findOne({ gameId: strGameId });
                if (!game || !game.players.includes(strTelegramId)) {
                    console.warn(`🚫 Blocked unpaid user ${strTelegramId} from joining game ${strGameId}`);
                    socket.emit("joinError", { message: "You are not registered in this game." });
                    return;
                }

                // --- NEW: Refresh activity ---
                refreshActivityAndCancelCleanup({ telegramId: strTelegramId, gameId: strGameId, context: 'GAME_PAGE' });

                // Set active socket key (ensure this reflects the game page context if applicable)
                await redis.set(`activeSocket:${strTelegramId}:${strGameId}:${socket.id}`, '1'); // Update key format

                // Add player to Redis set for gameRooms (main game active players)
                await redis.sAdd(getGameRoomsKey(strGameId), strTelegramId);
                const playerCountAfterJoin = await redis.sCard(getGameRoomsKey(strGameId));

                // Join the socket.io room
                socket.join(strGameId);

                // Emit updated player count to the game room
                io.to(strGameId).emit("playerCountUpdate", {
                    gameId: strGameId,
                    playerCount: playerCountAfterJoin,
                });

                // Confirm to the socket the gameId and telegramId
                socket.emit("gameId", { gameId: strGameId, telegramId: strTelegramId });

                console.log(`[joinGame] Player ${strTelegramId} joined game ${strGameId}, total players now: ${playerCountAfterJoin}`);

            } catch (err) {
                console.error("❌ Redis error in joinGame:", err);
                socket.emit("joinError", { message: "Failed to join the game page." });
            }
        });


        socket.on("gameCount", async ({ gameId }) => {
            const strGameId = String(gameId);

            // --- ⭐ CRITICAL CHANGE 1: Acquire Lock and Check State FIRST ⭐ ---
            if (state.activeDrawLocks[strGameId] || state.countdownIntervals[strGameId] || state.drawIntervals[strGameId] || state.drawStartTimeouts[strGameId]) {
                console.log(`⚠️ Game ${strGameId} already has an active countdown or draw lock in memory. Ignoring gameCount event.`);
                return;
            }

            const [redisHasLock, redisIsActive] = await Promise.all([
                redis.get(getActiveDrawLockKey(strGameId)),
                redis.get(getGameActiveKey(strGameId))
            ]);

            if (redisHasLock === "true" || redisIsActive === "true") {
                console.log(`⚠️ Game ${strGameId} is already active or locked in Redis. Ignoring gameCount event.`);
                return;
            }

            // ⭐ CRITICAL CHANGE 2: Set the lock *immediately after passing all checks* ⭐
            state.activeDrawLocks[strGameId] = true; // Set in-memory lock
            // Set Redis lock with a reasonable expiry, e.g., 5-10 minutes (300-600 seconds)
            await redis.set(getActiveDrawLockKey(strGameId), "true", 'EX', 600);
            console.log(`🚀 Attempting to start countdown for game ${strGameId}`);

            try {
                // --- 1. CLEANUP essential Redis keys and intervals ---
                await Promise.all([
                    redis.del(getGameActiveKey(strGameId)),
                    redis.del(getCountdownKey(strGameId)),
                    redis.del(getGameDrawStateKey(strGameId)),
                    redis.del(getGameDrawsKey(strGameId)),
                ]);

                if (state.countdownIntervals[strGameId]) {
                    clearInterval(state.countdownIntervals[strGameId]);
                    delete state.countdownIntervals[strGameId];
                }
                if (state.drawIntervals[strGameId]) {
                    clearInterval(state.drawIntervals[strGameId]);
                    delete state.drawIntervals[strGameId];
                }
                if (state.drawStartTimeouts[strGameId]) {
                    clearTimeout(state.drawStartTimeouts[strGameId]);
                    delete state.drawStartTimeouts[strGameId];
                }

                // 2. Prepare shuffled numbers and save to Redis under gameDrawStateKey
                const numbers = Array.from({ length: 75 }, (_, i) => i + 1).sort(() => Math.random() - 0.5);
                await redis.set(getGameDrawStateKey(strGameId), JSON.stringify({ numbers, index: 0 }));

                // 3. Create or update GameControl in DB
                const existing = await GameControl.findOne({ gameId: strGameId });
                const sessionId = uuidv4();
                state.gameSessionIds[strGameId] = sessionId;
                await redis.set(`gameSessionId:${strGameId}`, sessionId, 'EX', 3600 * 24);
                const stakeAmount = Number(strGameId); // Ideally configurable

                if (!existing) {
                    await GameControl.create({
                        sessionId,
                        gameId: strGameId,
                        stakeAmount,
                        totalCards: 0,
                        prizeAmount: 0,
                        isActive: false,
                        createdBy: "system",
                    });
                } else {
                    existing.sessionId = sessionId;
                    existing.stakeAmount = stakeAmount;
                    existing.totalCards = 0;
                    existing.prizeAmount = 0;
                    existing.isActive = false;
                    existing.createdAt = new Date();
                    await existing.save();
                }

                // 4. Countdown logic via Redis and setInterval
                let countdownValue = 15;
                await redis.set(getCountdownKey(strGameId), countdownValue.toString());

                io.to(strGameId).emit("countdownTick", { countdown: countdownValue });

                state.countdownIntervals[strGameId] = setInterval(async () => {
                    if (countdownValue > 0) {
                        countdownValue--;
                        io.to(strGameId).emit("countdownTick", { countdown: countdownValue });
                        await redis.set(getCountdownKey(strGameId), countdownValue.toString());
                    } else {
                        clearInterval(state.countdownIntervals[strGameId]);
                        delete state.countdownIntervals[strGameId];
                        await redis.del(getCountdownKey(strGameId));
                        console.log(`[gameCount] Countdown ended for game ${strGameId}`);

                        const currentPlayersInRoom = (await redis.sCard(getGameRoomsKey(strGameId))) || 0;
                        const prizeAmount = stakeAmount * currentPlayersInRoom;

                        if (currentPlayersInRoom === 0) {
                            console.log("🛑 No players left in game room after countdown. Stopping game initiation.");
                            io.to(strGameId).emit("gameNotStarted", {
                                gameId: strGameId,
                                message: "Not enough players in game room to start.",
                            });

                            // ⭐ CRITICAL CHANGE 3: Release lock and cleanup on no players ⭐
                            delete state.activeDrawLocks[strGameId]; // Release in-memory lock
                            await redis.del(getActiveDrawLockKey(strGameId)); // Release Redis lock
                            await syncGameIsActive(strGameId, false); // Explicitly mark game inactive
                            await resetRound(strGameId, io, state, redis);
                            return;
                        }

                        // --- CRITICAL RESET FOR GAME START (SESSION-ONLY RESET) ---
                        await clearGameSessions(strGameId, redis, state, io);
                        console.log(`🧹 ${getGameSessionsKey(strGameId)} cleared as game started.`);

                        // Note: Your original code had "All GameCards for ${strGameId} marked as taken."
                        // This implies you mark all existing game cards as taken.
                        // I'm assuming GameCard.findOneAndUpdate updates them as taken.

                        await GameControl.findOneAndUpdate(
                            { gameId: strGameId },
                            {
                                $set: {
                                    isActive: true,
                                    totalCards: currentPlayersInRoom,
                                    prizeAmount: prizeAmount,
                                    createdAt: new Date(),
                                },
                            }
                        );
                        await syncGameIsActive(strGameId, true);

                        await redis.set(getGameActiveKey(strGameId), "true");
                        state.gameIsActive[strGameId] = true;
                        state.gameReadyToStart[strGameId] = true;

                        io.to(strGameId).emit("cardsReset", { gameId: strGameId });
                        io.to(strGameId).emit("gameStart", { gameId: strGameId });

                        if (!state.drawIntervals[strGameId]) {
                            // ⭐ CRITICAL CHANGE 4: Ensure startDrawing also uses the same lock mechanism ⭐
                            // The startDrawing function also needs to check `state.activeDrawLocks`
                            await startDrawing(strGameId, io, state, redis);
                        }
                    }
                }, 1000);
            } catch (err) {
                console.error(`❌ Error in gameCount setup for ${gameId}:`, err.message);

                // --- ⭐ CRITICAL CHANGE 5: Release lock and cleanup on error ⭐
                delete state.activeDrawLocks[strGameId];
                await redis.del(getActiveDrawLockKey(strGameId));
                await syncGameIsActive(strGameId, false);

                delete state.gameDraws[strGameId];
                delete state.countdownIntervals[strGameId];
                delete state.gameSessionIds[strGameId];
                await redis.del(`gameSessionId:${strGameId}`);

                await Promise.all([
                    redis.del(getGameDrawsKey(strGameId)),
                    redis.del(getCountdownKey(strGameId)),
                    redis.del(getGameActiveKey(strGameId)),
                    redis.del(getGameDrawStateKey(strGameId)),
                ]);
                io.to(strGameId).emit("gameNotStarted", { gameId: strGameId, message: "Error during game setup. Please try again." });
            }
        });


        async function startDrawing(gameId, io, state, redis) {
            const strGameId = String(gameId);
            const gameDrawStateKey = getGameDrawStateKey(strGameId);
            const gameDrawsKey = getGameDrawsKey(strGameId);
            const gameRoomsKey = getGameRoomsKey(strGameId);
            const activeGameKey = getGameActiveKey(strGameId);

            if (state.drawIntervals[strGameId]) {
                console.log(`⛔️ Drawing already in progress for game ${strGameId}, skipping.`);
                return;
            }

            console.log(`🎯 Starting the drawing process for gameId: ${strGameId}`);

            await redis.del(gameDrawsKey);

            state.drawIntervals[strGameId] = setInterval(async () => {
                try {
                    const currentPlayersInRoom = (await redis.sCard(gameRoomsKey)) || 0;

                    if (currentPlayersInRoom === 0) {
                        console.log(`🛑 No players left in game room ${strGameId}. Stopping drawing and initiating round reset.`);
                        clearInterval(state.drawIntervals[strGameId]);
                        delete state.drawIntervals[strGameId];

                        await resetRound(strGameId, io, state, redis);

                        io.to(strGameId).emit("gameEnded", { gameId: strGameId, message: "Game ended due to all players leaving the room." });
                        return;
                    }

                    const gameDataRaw = await redis.get(gameDrawStateKey);
                    if (!gameDataRaw) {
                        console.log(`❌ No game draw data found for ${strGameId}, stopping draw.`);
                        clearInterval(state.drawIntervals[strGameId]);
                        delete state.drawIntervals[strGameId];
                        return;
                    }
                    const gameData = JSON.parse(gameDataRaw);

                    if (gameData.index >= gameData.numbers.length) {
                        clearInterval(state.drawIntervals[strGameId]);
                        delete state.drawIntervals[strGameId];
                        io.to(strGameId).emit("allNumbersDrawn", { gameId: strGameId });
                        console.log(`🎯 All numbers drawn for game ${strGameId}`);

                        await resetRound(strGameId, io, state, redis);

                        io.to(strGameId).emit("gameEnded", { gameId: strGameId, message: "All numbers drawn, game ended." });
                        return;
                    }

                    const number = gameData.numbers[gameData.index];
                    gameData.index += 1;

                    await redis.set(gameDrawStateKey, JSON.stringify(gameData));
                    await redis.rPush(gameDrawsKey, number.toString());

                    const letterIndex = Math.floor((number - 1) / 15);
                    const letter = ["B", "I", "N", "G", "O"][letterIndex];
                    const label = `${letter}-${number}`;

                    console.log(`🔢 Drawing number: ${label}, Index: ${gameData.index - 1}`);

                    io.to(strGameId).emit("numberDrawn", { number, label, gameId: strGameId });

                } catch (error) {
                    console.error(`❌ Error during drawing interval for game ${strGameId}:`, error);
                    clearInterval(state.drawIntervals[strGameId]);
                    delete state.drawIntervals[strGameId];
                    await resetRound(strGameId, io, state, redis);
                    io.to(strGameId).emit("gameEnded", { gameId: strGameId, message: "Game ended due to drawing error." });
                }
            }, 3000); // Draw every 3 seconds
        }


        //check winner
        socket.on("checkWinner", async ({ telegramId, gameId, cartelaId, selectedNumbers }) => {
            const strGameId = String(gameId);
            const strTelegramId = String(telegramId);
            const numericCardId = Number(cartelaId);
            const selectedSet = new Set((selectedNumbers || []).map(Number));

            // --- NEW: Refresh activity ---
            refreshActivityAndCancelCleanup({ telegramId: strTelegramId, gameId: strGameId, context: 'GAME_PAGE' });

            try {
                if (isNaN(numericCardId)) {
                    socket.emit("winnerError", { message: "Invalid or missing card ID." });
                    console.error("❌ checkWinner: cartelaId is NaN or invalid:", cartelaId);
                    return;
                }

                // 1. Get drawn numbers as list from Redis
                const drawnNumbersRaw = await redis.lRange(getGameDrawsKey(strGameId), 0, -1);
                if (!drawnNumbersRaw || drawnNumbersRaw.length === 0) {
                    socket.emit("winnerError", { message: "No numbers have been drawn yet." });
                    console.warn(`No drawn numbers found for game ${strGameId} when ${strTelegramId} checked winner.`);
                    return;
                }
                const drawnNumbers = new Set(drawnNumbersRaw.map(Number));
                console.log(`Drawn numbers for game ${strGameId}:`, [...drawnNumbers].join(', '));


                // 2. Retrieve the player's card from the database
                const gameCard = await GameCard.findOne({
                    gameId: strGameId,
                    cardId: numericCardId,
                    takenBy: strTelegramId,
                    isTaken: true
                });

                if (!gameCard) {
                    socket.emit("winnerError", { message: "Card not found or not owned by you." });
                    console.warn(`Card ${numericCardId} not found or not owned by ${strTelegramId} for game ${strGameId}.`);
                    return;
                }

                // Make sure the card is a valid 2D array of numbers
                const card = gameCard.card.map(row => row.map(cell => (cell === "FREE" ? 0 : Number(cell))));

                // 3. Verify that all selected numbers on the client-side are indeed drawn numbers
                for (const num of selectedSet) {
                    if (!drawnNumbers.has(num)) {
                        console.warn(`Player ${strTelegramId} submitted selected number ${num} that was not yet drawn.`);
                        socket.emit("winnerError", { message: `Selected number ${num} has not been drawn yet. Please mark only drawn numbers.` });
                        return;
                    }
                }

                // 4. Check for Bingo patterns using the server-side card and drawn numbers
                const patternsFound = checkBingoPattern(card, drawnNumbers, selectedSet);
                console.log(`Patterns found for ${strTelegramId} on card ${numericCardId}:`, patternsFound);

                if (patternsFound.length > 0) {
                    const gameActiveStatus = await redis.get(getGameActiveKey(strGameId));
                    if (gameActiveStatus !== 'true') {
                        socket.emit("winnerError", { message: "Game is no longer active. Cannot claim bingo." });
                        return;
                    }
                    // Process the winner
                    await processWinner({
                        gameId: strGameId,
                        telegramId: strTelegramId,
                        cardId: numericCardId,
                        patterns: patternsFound,
                        io: io, // Pass io instance
                        state: state, // Pass state instance
                        redis: redis // Pass redis instance
                    });
                } else {
                    socket.emit("noBingo", { message: "No bingo found with current selections." });
                }

            } catch (err) {
                console.error("❌ Error in checkWinner:", err);
                socket.emit("winnerError", { message: "An error occurred while checking for a winner." });
            }
        });


        async function processWinner({ gameId, telegramId, cardId, patterns, io, state, redis }) {
            const strGameId = String(gameId);
            const strTelegramId = String(telegramId);
            const activeGameKey = getGameActiveKey(strGameId);
            const gameDrawsKey = getGameDrawsKey(strGameId);

            // Ensure the game is still active to prevent multiple winners
            const gameActive = await redis.get(activeGameKey);
            if (gameActive !== "true") {
                console.log(`Game ${strGameId} is no longer active. Skipping winner processing for ${strTelegramId}.`);
                return io.to(strTelegramId).emit("winnerDeclined", { message: "Game already ended or winner processed." });
            }

            // Prevent further winners for this game
            await redis.set(activeGameKey, "false");
            state.gameIsActive[strGameId] = false;
            console.log(`Game ${strGameId} set to inactive for winner processing.`);

            // Clear drawing interval if running
            if (state.drawIntervals[strGameId]) {
                clearInterval(state.drawIntervals[strGameId]);
                delete state.drawIntervals[strGameId];
                console.log(`Drawing interval for game ${strGameId} cleared.`);
            }

            // Fetch game details from GameControl DB
            const gameControl = await GameControl.findOne({ gameId: strGameId });
            if (!gameControl) {
                console.error(`GameControl not found for game ${strGameId} during winner processing.`);
                return io.to(strTelegramId).emit("winnerError", { message: "Game data not found." });
            }

            // Retrieve all drawn numbers for history
            const drawnNumbers = await redis.lRange(gameDrawsKey, 0, -1);

            // Record Game History
            const gameHistory = new GameHistory({
                gameId: strGameId,
                sessionId: gameControl.sessionId,
                winnerTelegramId: strTelegramId,
                winnerCardId: cardId,
                winningPatterns: patterns,
                prizeAmount: gameControl.prizeAmount,
                totalPlayers: gameControl.totalCards, // totalCards is actually total players with cards
                drawnNumbers: drawnNumbers.map(Number),
                endedAt: new Date(),
            });
            await gameHistory.save();
            console.log(`Game history saved for game ${strGameId}, winner ${strTelegramId}.`);

            // Update winner's balance (example, integrate with your User model logic)
            const winner = await User.findOneAndUpdate(
                { telegramId: strTelegramId },
                { $inc: { balance: gameControl.prizeAmount } },
                { new: true }
            );
            console.log(`Winner ${strTelegramId} balance updated to ${winner?.balance}.`);

            // Emit winner declaration to all players in the game room
            io.to(strGameId).emit("winnerDeclared", {
                winnerTelegramId: strTelegramId,
                cardId: cardId,
                patterns: patterns,
                prize: gameControl.prizeAmount,
                message: `🎉 Player ${strTelegramId} won with Bingo!`,
            });
            console.log(`Winner declared event emitted for game ${strGameId}.`);

            // Reset the game for a new round
            await resetRound(strGameId, io, state, redis); // Use resetRound for comprehensive cleanup
            console.log(`Game ${strGameId} reset after winner processing.`);
        }


        // Player explicitly leaves the game (e.g., clicks a "Leave Game" button)
        socket.on("playerLeave", async ({ gameId, telegramId, context }, callback) => { // Add context here
            console.log(`Player ${telegramId} (socket: ${socket.id}) is explicitly leaving game ${gameId}.`);
            const strGameId = String(gameId);
            const strTelegramId = String(telegramId);
            const userContext = context || 'GAME_PAGE'; // Default context if not provided

            // Immediately clear any pending disconnect cleanup if the user explicitly leaves
            const disconnectKey = `${strTelegramId}:${strGameId}`;
            if (pendingDisconnectTimeouts.has(disconnectKey)) {
                clearTimeout(pendingDisconnectTimeouts.get(disconnectKey));
                pendingDisconnectTimeouts.delete(disconnectKey);
                console.log(`Cancelled pending disconnect cleanup for ${disconnectKey} due to explicit leave.`);
            }

            // Also clear activity timestamp
            activeGamePlayersTimestamps.delete(`${strGameId}-${strTelegramId}`);
            console.log(`Removed ${strGameId}-${strTelegramId} from activeGamePlayersTimestamps due to explicit leave.`);

            // Perform the full cleanup immediately
            await removePlayerFromGame(strGameId, strTelegramId);
            socket.leave(strGameId);
            if (callback) {
                callback();
            }
        });

        socket.on("disconnect", async () => {
            console.log(`⚡️ Client disconnected: ${socket.id}`);

            // The userSelectionKey now stores socket.id -> {telegramId, gameId, cardId, card}
            const userSelectionKey = `userSelections`;
            const selectionRaw = await redis.hGet(userSelectionKey, socket.id);

            if (selectionRaw) {
                const { telegramId, gameId } = JSON.parse(selectionRaw);
                const strGameId = String(gameId);
                const strTelegramId = String(telegramId);

                console.log(`Socket ${socket.id} (Player ${strTelegramId}) was associated with game ${strGameId}.`);

                // Remove the socket's specific selection from Redis immediately
                await redis.hDel(userSelectionKey, socket.id);

                // --- NEW: Remove the specific active socket entry from Redis ---
                await redis.del(`activeSocket:${strTelegramId}:${strGameId}:${socket.id}`);

                // Check if this Telegram ID still has *any* active sockets for this game
                // --- NEW: Update key pattern for active sockets query ---
                const activeSocketsForUser = await redis.keys(`activeSocket:${strTelegramId}:${strGameId}:*`);

                if (activeSocketsForUser.length === 0) {
                    console.log(`User ${strTelegramId} has no more active sockets for game ${strGameId}.`);
                    // --- NEW: Determine context and schedule contextual cleanup ---
                    // Infer context based on game active status
                    const isGameActive = await redis.get(getGameActiveKey(strGameId)) === "true";
                    const inferredContext = isGameActive ? 'GAME_PAGE' : 'CARD_SELECTION';
                    console.log(`Inferred context for disconnected user ${strTelegramId}: ${inferredContext}`);

                    scheduleDisconnectCleanup({
                        telegramId: strTelegramId,
                        gameId: strGameId,
                        context: inferredContext
                    });

                } else {
                    console.log(`User ${strTelegramId} still has ${activeSocketsForUser.length} active sockets for game ${strGameId}. Not initiating full cleanup yet.`);
                }
            } else {
                console.log(`Disconnected socket ${socket.id} had no user selection data.`);
            }
        });
    });
};