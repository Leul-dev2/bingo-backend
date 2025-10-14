const User = require("../models/user");
const GameControl = require("../models/GameControl");
const GameHistory = require("../models/GameHistory")
const Ledger = require("../models/ledgerSchema");
const resetGame = require("../utils/resetGame");
const checkAndResetIfEmpty = require("../utils/checkandreset");
const redis = require("../utils/redisClient");
const  syncGameIsActive = require("../utils/syncGameIsActive");
const GameCard = require('../models/GameCard');
const checkBingoPattern = require("../utils/BingoPatterns")
const resetRound = require("../utils/resetRound");
const clearGameSessions = require('../utils/clearGameSessions');
const deleteCardsByTelegramId = require('../utils/deleteCardsByTelegramId');
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
const { Socket } = require("socket.io");
const pendingDisconnectTimeouts = new Map();
const ACTIVE_DISCONNECT_GRACE_PERIOD_MS = 2 * 1000;
const JOIN_GAME_GRACE_PERIOD_MS = 2 * 1000;
const ACTIVE_SOCKET_TTL_SECONDS = 60 * 3;

// ✅ NEW: Game Queue Constants
const MAX_PLAYERS_PER_GAME = 6;
const GAME_DURATION_MS = 5 * 60 * 1000; // 5 minutes per game

module.exports = function registerGameSocket(io) {
let gameSessions = {};
let gameSessionIds = {}; 
let userSelections = {};
let gameCards = {};
const gameDraws = {};
const countdownIntervals = {};
const drawIntervals = {};
const activeDrawLocks = {};
const gameReadyToStart = {};
let drawStartTimeouts = {};
const gameIsActive = {};
const gamePlayers = {};
const gameRooms = {};
const joiningUsers = new Set();
const { v4: uuidv4 } = require("uuid");

// ✅ NEW: Game Queue Management
const gameQueues = {}; // { [gameId]: [telegramId1, telegramId2, ...] }
const activeGames = {}; // { [gameId]: { players: [], startTime: Date, GameSessionId: string } }

const state = {
  countdownIntervals: {},
  drawIntervals: {},
  drawStartTimeouts: {},
  activeDrawLocks: {},
  gameDraws: {},
  gameSessionIds: {},
  gameIsActive: {},
  gameReadyToStart: {},
};

// ✅ NEW: Queue Management Functions
async function manageGameQueue(gameId, telegramId, io, redis) {
    const strGameId = String(gameId);
    
    if (!gameQueues[strGameId]) {
        gameQueues[strGameId] = [];
    }
    
    const queue = gameQueues[strGameId];
    
    // Add player to queue if not already in it
    if (!queue.includes(telegramId)) {
        queue.push(telegramId);
        console.log(`🎯 Player ${telegramId} added to queue for game ${strGameId}. Queue length: ${queue.length}`);
    }
    
    // Emit queue position to the player
    const position = queue.indexOf(telegramId) + 1;
    io.to(telegramId).emit("queuePosition", {
        gameId: strGameId,
        position: position,
        totalInQueue: queue.length
    });
    
    // Start game if we have enough players and no active game
    if (queue.length >= 2 && !activeGames[strGameId]) {
        await startNextGame(strGameId, io, redis);
    }
    
    return position;
}

async function startNextGame(gameId, io, redis) {
    const strGameId = String(gameId);
    const queue = gameQueues[strGameId];
    
    if (!queue || queue.length < 2 || activeGames[strGameId]) {
        return;
    }
    
    // Take players for this game (up to MAX_PLAYERS_PER_GAME)
    const playersForGame = queue.splice(0, MAX_PLAYERS_PER_GAME);
    
    // Generate unique GameSessionId
    const GameSessionId = uuidv4();
    
    // Create active game record
    activeGames[strGameId] = {
        players: playersForGame,
        startTime: Date.now(),
        GameSessionId: GameSessionId
    };
    
    console.log(`🚀 Starting game ${strGameId} with session ${GameSessionId}. Players: ${playersForGame.join(', ')}`);
    
    // Notify players they are entering the game
    playersForGame.forEach(telegramId => {
        io.to(telegramId).emit("enteringGame", {
            gameId: strGameId,
            GameSessionId: GameSessionId,
            playersInGame: playersForGame.length
        });
        
        // Remove from lobby and add to game room
        redis.sRem(`gameSessions:${strGameId}`, telegramId);
        redis.sAdd(`gameRooms:${strGameId}`, telegramId);
    });
    
    // Update queue positions for remaining players
    updateQueuePositions(strGameId, io);
    
    // Set up game cleanup timer
    setTimeout(() => {
        cleanupFinishedGame(strGameId, io, redis);
    }, GAME_DURATION_MS);
    
    return GameSessionId;
}

function updateQueuePositions(gameId, io) {
    const strGameId = String(gameId);
    const queue = gameQueues[strGameId];
    
    if (queue) {
        queue.forEach((telegramId, index) => {
            io.to(telegramId).emit("queuePosition", {
                gameId: strGameId,
                position: index + 1,
                totalInQueue: queue.length
            });
        });
    }
}

async function cleanupFinishedGame(gameId, io, redis) {
    const strGameId = String(gameId);
    const activeGame = activeGames[strGameId];
    
    if (!activeGame) return;
    
    console.log(`🧹 Cleaning up finished game ${strGameId}`);
    
    // Notify players game is ending
    activeGame.players.forEach(telegramId => {
        io.to(telegramId).emit("gameEnding", {
            gameId: strGameId,
            GameSessionId: activeGame.GameSessionId
        });
    });
    
    // Remove active game
    delete activeGames[strGameId];
    
    // Start next game if there are players waiting
    if (gameQueues[strGameId] && gameQueues[strGameId].length >= 2) {
        await startNextGame(strGameId, io, redis);
    }
}

function removeFromQueue(gameId, telegramId, io) {
    const strGameId = String(gameId);
    
    if (gameQueues[strGameId]) {
        const index = gameQueues[strGameId].indexOf(telegramId);
        if (index > -1) {
            gameQueues[strGameId].splice(index, 1);
            console.log(`❌ Player ${telegramId} removed from queue for game ${strGameId}`);
            updateQueuePositions(strGameId, io);
        }
    }
}

function getQueueInfo(gameId) {
    const strGameId = String(gameId);
    const queue = gameQueues[strGameId] || [];
    const activeGame = activeGames[strGameId];
    
    return {
        queueLength: queue.length,
        activeGame: !!activeGame,
        playersInActiveGame: activeGame ? activeGame.players.length : 0
    };
}

  io.on("connection", (socket) => {
      console.log("🟢 New client connected");
      console.log("Client connected with socket ID:", socket.id);

      // ✅ Send a heartbeat to all connected clients every 5 seconds
        setInterval(() => {
        io.emit("heartbeat", Date.now());
        }, 3000);       

    // User joins a game lobby phase
    socket.on("userJoinedGame", async ({ telegramId, gameId }) => {
        console.log("userJoined invoked");
        const strGameId = String(gameId);
        const strTelegramId = String(telegramId);

        try {
            const userSelectionKey = `userSelections`;
            const userOverallSelectionKey = `userSelectionsByTelegramId`;
            const gameCardsKey = `gameCards:${strGameId}`;
            const sessionKey = `gameSessions:${strGameId}`;
            const gamePlayersKey = `gamePlayers:${strGameId}`;

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

            // ✅ FIX: Don't clean up joinGame phase info immediately - preserve for navigation
            const existingJoinGameInfo = await redis.hGet(`joinGameSocketsInfo`, socket.id);
            if (existingJoinGameInfo) {
                console.log(`🔄 Socket ${socket.id} transitioning from joinGame to lobby phase for user ${strTelegramId}`);
                // Keep the joinGame info for potential fallback during navigation
                await redis.hSet(`previousJoinGameInfo`, socket.id, existingJoinGameInfo);
                await redis.expire(`previousJoinGameInfo`, 30);
            }

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
            await redis.set(`activeSocket:${strTelegramId}:${socket.id}`, '1', 'EX', ACTIVE_SOCKET_TTL_SECONDS);
            socket.join(strGameId);

            await redis.hSet(userSelectionKey, socket.id, JSON.stringify({
                telegramId: strTelegramId,
                gameId: strGameId,
                cardId: currentHeldCardId,
                card: currentHeldCard,
                phase: 'lobby'
            }));
            console.log(`Backend: Socket ${socket.id} for ${strTelegramId} set up with cardId: ${currentHeldCardId || 'null'} in 'lobby' phase.`);

            // --- Step 4: Add user to Redis Sets (Lobby and Overall Game Players) ---
            await redis.sAdd(sessionKey, strTelegramId);
            await redis.sAdd(gamePlayersKey, strTelegramId);
            console.log(`Backend: Added ${strTelegramId} to Redis SETs: ${sessionKey} and ${gamePlayersKey}.`);

            // ✅ NEW: Add player to game queue
            const queuePosition = await manageGameQueue(strGameId, strTelegramId, io, redis);

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

    socket.on("cardSelected", async (data) => {
    const { telegramId, cardId, card, gameId, requestId } = data;

    // --- 1. Data Sanitization & Key Preparation ---
    const strTelegramId = String(telegramId);
    const strCardId = String(cardId);
    const strGameId = String(gameId);
    const cleanCard = card.map(row => row.map(c => (c === "FREE" ? 0 : Number(c))));

    const userActionLockKey = `lock:userAction:${strGameId}:${strTelegramId}`;
    const cardLockKey = `lock:card:${strGameId}:${strCardId}`;

    // Redis keys
    const gameCardsKey = `gameCards:${strGameId}`;
    const userSelectionsKey = `userSelections`;
    const userSelectionsByTelegramIdKey = `userSelectionsByTelegramId`;
    const userLastRequestIdKey = `userLastRequestId`;

    // --- 2. Acquire User-Level Lock ---
    const userLock = await redis.set(userActionLockKey, requestId, "NX", "EX", 10);
    if (!userLock) {
        return socket.emit("cardError", {
            message: "⏳ Your previous action is still processing. Please wait a moment.",
            requestId
        });
    }

    try {
        // --- 3. Get User's Current Selection from the authoritative source: gameCardsKey ---
        const existingOwnerId = await redis.hGet(gameCardsKey, strCardId);
        
        // --- 4. Get the user's *previous* selection to clean up ---
        let previousCardIdToRelease = null;
        const allGameCards = await redis.hGetAll(gameCardsKey);
        
        for (const [key, value] of Object.entries(allGameCards)) {
            if (value === strTelegramId) {
                previousCardIdToRelease = key;
                break;
            }
        }
        
        // Exit early if the user is selecting the same card they already have
        if (existingOwnerId === strTelegramId) {
            socket.emit("cardConfirmed", { cardId: strCardId, card: cleanCard, requestId });
            return;
        }

        // --- 5. Check Card Availability & Acquire Card-Level Lock ---
        // The card is taken by someone else
        if (existingOwnerId && existingOwnerId !== strTelegramId) {
              
    // A) Find the player's currently held card from Redis
            const previousCardIdToRelease = Object.keys(allGameCards).find(
                key => allGameCards[key] === strTelegramId
            );
        // B) If they had a card, release it from the DB and Redis
        if (previousCardIdToRelease) {
            // Asynchronously update the DB and Redis
            await Promise.all([
                GameCard.updateOne(
                    { gameId: strGameId, cardId: Number(previousCardIdToRelease), takenBy: strTelegramId },
                    { $set: { isTaken: false, takenBy: null } }
                ),
                redis.hDel(gameCardsKey, previousCardIdToRelease)
            ]);

            // Notify other clients about the released card
            socket.to(strGameId).emit("cardReleased", { 
                cardId: previousCardIdToRelease, 
                telegramId: strTelegramId 
            });
        }
            return socket.emit("cardUnavailable", { cardId: strCardId, requestId });
        }

        const cardLock = await redis.set(cardLockKey, strTelegramId, "NX", "EX", 10);
        if (!cardLock) {
            return socket.emit("cardUnavailable", { cardId: strCardId, requestId });
        }

        // --- 6. Perform the Atomic Swap: Release Old Card, Claim New Card ---

        // A) Release any previously held card(s) in the database.
        const dbUpdatePromises = [];
        dbUpdatePromises.push(
            GameCard.updateOne(
                { gameId: strGameId, cardId: { $ne: Number(strCardId) }, takenBy: strTelegramId },
                { $set: { isTaken: false, takenBy: null } }
            )
        );

        // B) Clean up Redis for the old card and notify clients.
        if (previousCardIdToRelease && previousCardIdToRelease !== strCardId) {
            dbUpdatePromises.push(
                redis.hDel(gameCardsKey, previousCardIdToRelease)
            );
            socket.to(strGameId).emit("cardReleased", { cardId: previousCardIdToRelease, telegramId: strTelegramId });
        }

        // C) Claim the new card in both DB and Redis
        const selectionData = JSON.stringify({
            telegramId: strTelegramId,
            cardId: strCardId,
            card: cleanCard,
            gameId: strGameId
        });

        dbUpdatePromises.push(
            GameCard.updateOne(
                { gameId: strGameId, cardId: Number(strCardId) },
                { $set: { card: cleanCard, isTaken: true, takenBy: strTelegramId } },
                { upsert: true }
            ),
            redis.hSet(gameCardsKey, strCardId, strTelegramId),
            redis.hSet(userSelectionsKey, socket.id, selectionData),
            redis.hSet(userSelectionsByTelegramIdKey, strTelegramId, selectionData),
            redis.hSet(userLastRequestIdKey, strTelegramId, requestId)
        );

        await Promise.all(dbUpdatePromises);

        // --- 7. Broadcast Updates & Confirmations ---
        socket.emit("cardConfirmed", { cardId: strCardId, card: cleanCard, requestId });
        socket.to(strGameId).emit("otherCardSelected", { telegramId: strTelegramId, cardId: strCardId });

        const [updatedSelections, numberOfPlayers] = await Promise.all([
            redis.hGetAll(gameCardsKey),
            redis.sCard(`gameSessions:${strGameId}`)
        ]);

        io.to(strGameId).emit("currentCardSelections", updatedSelections);
        io.to(strGameId).emit("gameid", { gameId: strGameId, numberOfPlayers });

    } catch (err) {
        console.error(`❌ cardSelected error for game ${strGameId}, user ${strTelegramId}:`, err);
        socket.emit("cardError", { message: "An unexpected error occurred. Please try again.", requestId });
    } finally {
        // --- 8. Release All Locks ---
        await redis.del(userActionLockKey);
        await redis.del(cardLockKey);
    }
    });

    socket.on("unselectCardOnLeave", async ({ gameId, telegramId, cardId }) => {
        console.log("unselectCardOnLeave is called");
        console.log("unslected datas ", gameId, telegramId, cardId );

        try {
          const strCardId = String(cardId);
          const strTelegramId = String(telegramId);

          const currentCardOwner = await redis.hGet(`gameCards:${gameId}`, strCardId);
          console.log("🍔🍔🍔 cardowner", currentCardOwner);

          if (currentCardOwner === strTelegramId) {
            await redis.hDel(`gameCards:${gameId}`, strCardId);
            await GameCard.findOneAndUpdate(
              { gameId, cardId: Number(strCardId) },
              { isTaken: false, takenBy: null }
            );

           await Promise.all([
            redis.hDel("userSelections", socket.id),
            redis.hDel("userSelections", strTelegramId),
            redis.hDel("userSelectionsByTelegramId", strTelegramId),
            redis.del(`activeSocket:${strTelegramId}:${socket.id}`),
        ]);
            socket.to(gameId).emit("cardAvailable", { cardId: strCardId });

            console.log(`🧹🔥🔥🔥🔥 Card ${strCardId} released by ${strTelegramId}`);
          }
        } catch (err) {
          console.error("unselectCardOnLeave error:", err);
        }
      });

    socket.on("joinGame", async ({ gameId, GameSessionId, telegramId }) => {
        console.log("joinGame is invoked 🔥🔥🔥");
        try {
            const strGameId = String(gameId);
            const strGameSessionId = String(GameSessionId);
            const strTelegramId = String(telegramId);
            const timeoutKey = `${strTelegramId}:${strGameId}:joinGame`;

            console.log("gameSessionID inside joingame", GameSessionId );

            // CRITICAL: Check for and cancel any pending cleanup for this user.
            if (pendingDisconnectTimeouts.has(timeoutKey)) {
                clearTimeout(pendingDisconnectTimeouts.get(timeoutKey));
                pendingDisconnectTimeouts.delete(timeoutKey);
                console.log(`🕒 Player ${strTelegramId} reconnected within the grace period. Cancelling cleanup.`);
            }

            // MODIFIED: Find the game and the specific player object within it.
            const game = await GameControl.findOne({ GameSessionId: strGameSessionId, 'players.telegramId': Number(strTelegramId) });

            // --- NEW LOGIC: Check if the player was in the game, but the game is now over. ---
            if (game?.endedAt) {
                console.log(`🔄 Player ${strTelegramId} tried to join a game that has ended.`);
                const winnerRaw = await redis.get(`winnerInfo:${strGameSessionId}`);
                if (winnerRaw) {
                    const winnerInfo = JSON.parse(winnerRaw);
                    // Redirect to winner page
                    socket.emit("winnerConfirmed", winnerInfo);
                    console.log(`✅ Redirecting player ${strTelegramId} to winner page.`);
                } else {
                    // Redirect to home page
                    socket.emit("gameEnd", { message: "The game has ended." });
                    console.log(`✅ Redirecting player ${strTelegramId} to home page.`);
                }
                return;
            }

            // If no record is found, the user was never in this game session.
            if (!game) {
                socket.emit("gameEnd", { message: "The game has ended." });
                console.warn(`🚫 Blocked user ${strTelegramId} from joining game session ${strGameSessionId} because no player record was found.`);
                const winnerRaw = await redis.get(`winnerInfo:${strGameSessionId}`);
                if (winnerRaw) {
                    const winnerInfo = JSON.parse(winnerRaw);
                    socket.emit("winnerConfirmed", winnerInfo);
                    return;
                }
                socket.emit("joinError", { message: "You are not registered in this game." });
                return;
            }

            // NEW: Update the player's status to 'connected' and save the document.
            await GameControl.findOneAndUpdate(
                { GameSessionId: strGameSessionId, 'players.telegramId': Number(strTelegramId) },
                { $set: { 'players.$.status': 'connected' } },
                { new: true }
            );
            console.log(`👤 Player ${strTelegramId} status updated to 'connected' for game ${strGameId}.`);

           const joinGameSocketInfo = await redis.hSet(`joinGameSocketsInfo`, socket.id, JSON.stringify({
                telegramId: strTelegramId,
                gameId: strGameId,
                GameSessionId: strGameSessionId,
                phase: 'joinGame'
            }));
            await redis.set(`activeSocket:${strTelegramId}:${socket.id}`, '1', 'EX', ACTIVE_SOCKET_TTL_SECONDS);
            console.log(`Backend: Socket ${socket.id} for ${strTelegramId} set up in 'joinGame' phase.`);
            console.log("joinsocket info🔥🔥", joinGameSocketInfo.GameSessionId);

            await redis.sAdd(`gameRooms:${strGameId}`, strTelegramId);
            console.log("➕➕➕players added to gameRooms", `gameRooms:${strGameId}`);
            socket.join(strGameId);

            const playerCount = await redis.sCard(`gameRooms:${strGameId}`);
            io.to(strGameId).emit("playerCountUpdate", {
                gameId: strGameId,
                playerCount,
            });
            console.log(`[joinGame] Player ${strTelegramId} joined game ${strGameId}, total players now: ${playerCount}`);

            socket.emit("gameId", {
                gameId: strGameId,
                GameSessionId: strGameSessionId,
                telegramId: strTelegramId
            });

            const gameDrawsKey = getGameDrawsKey(strGameSessionId);
            const drawnNumbersRaw = await redis.lRange(gameDrawsKey, 0, -1);
            const drawnNumbers = drawnNumbersRaw.map(Number);
            const formattedDrawnNumbers = drawnNumbers.map(number => {
                const letterIndex = Math.floor((number - 1) / 15);
                const letter = ["B", "I", "N", "G", "O"][letterIndex];
                return { number, label: `${letter}-${number}` };
            });

            if (formattedDrawnNumbers.length > 0) {
                socket.emit("drawnNumbersHistory", {
                    gameId: strGameId,
                    GameSessionId: strGameSessionId,
                    history: formattedDrawnNumbers
                });
                console.log(`[joinGame] Sent ${formattedDrawnNumbers.length} historical drawn numbers to ${strTelegramId} for session ${strGameSessionId}.`);
            }
        } catch (err) {
            console.error("❌ Redis error in joinGame:", err);
            socket.emit("joinError", { message: "Failed to join game. Please refresh or retry." });
        }
    });

    // ✅ NEW: Socket state recovery for navigation between pages
    socket.on("recoverSocketState", async ({ telegramId, gameId, GameSessionId, fromPage }) => {
        const strTelegramId = String(telegramId);
        const strGameId = String(gameId);
        
        console.log(`🔄 Recovering socket state for ${strTelegramId} from ${fromPage} page`);

        try {
            // Check if user has active sockets in different phases
            const activeSocketKeys = await redis.keys(`activeSocket:${strTelegramId}:*`);
            
            if (activeSocketKeys.length > 0) {
                // User has other active connections, reuse state
                console.log(`✅ User ${strTelegramId} has ${activeSocketKeys.length} active sockets, recovering state`);
                
                // Re-join appropriate rooms based on current phase
                socket.join(strGameId);
                
                // Re-emit current game state
                if (fromPage === 'bingoGame') {
                    // User is returning to bingo game, send current game state
                    const gameDrawsKey = getGameDrawsKey(GameSessionId);
                    const drawnNumbersRaw = await redis.lRange(gameDrawsKey, 0, -1);
                    const drawnNumbers = drawnNumbersRaw.map(Number);
                    
                    if (drawnNumbers.length > 0) {
                        const formattedDrawnNumbers = drawnNumbers.map(number => {
                            const letterIndex = Math.floor((number - 1) / 15);
                            const letter = ["B", "I", "N", "G", "O"][letterIndex];
                            return { number, label: `${letter}-${number}` };
                        });
                        
                        socket.emit("drawnNumbersHistory", {
                            gameId: strGameId,
                            GameSessionId: GameSessionId,
                            history: formattedDrawnNumbers
                        });
                    }
                    
                    // Send current player count
                    const playerCount = await redis.sCard(`gameRooms:${strGameId}`) || 0;
                    socket.emit("playerCountUpdate", {
                        gameId: strGameId,
                        playerCount,
                    });
                }
                
                socket.emit("socketStateRecovered", { 
                    success: true, 
                    message: "Socket state recovered successfully" 
                });
            } else {
                // No active sockets found, need fresh join
                console.log(`⚠️ No active sockets found for ${strTelegramId}, initiating fresh join`);
                socket.emit("socketStateRecoveryFailed", { 
                    message: "Please rejoin the game" 
                });
            }
        } catch (error) {
            console.error("❌ Socket state recovery error:", error);
            socket.emit("socketStateRecoveryFailed", { 
                message: "Recovery failed, please refresh" 
            });
        }
    });

    // ✅ NEW: Socket state preservation for navigation
    socket.on("preserveSocketState", async ({ telegramId, gameId, GameSessionId, currentPhase }) => {
        const strTelegramId = String(telegramId);
        const strGameId = String(gameId);
        
        console.log(`💾 Preserving socket state for ${strTelegramId} in phase ${currentPhase}`);
        
        try {
            // Extend TTL for active socket to prevent cleanup during navigation
            await redis.expire(`activeSocket:${strTelegramId}:${socket.id}`, 60);
            
            // Preserve phase-specific info with longer TTL
            if (currentPhase === 'lobby') {
                await redis.expire(`userSelections`, 60);
            } else if (currentPhase === 'joinGame') {
                await redis.expire(`joinGameSocketsInfo`, 60);
            }
            
            socket.emit("socketStatePreserved", { success: true });
        } catch (error) {
            console.error("❌ Socket state preservation error:", error);
        }
    });

    // ✅ NEW: Get queue information
    socket.on("getQueueInfo", ({ gameId }) => {
        const strGameId = String(gameId);
        const queueInfo = getQueueInfo(strGameId);
        socket.emit("queueInfo", queueInfo);
    });

    // ✅ NEW: Force start game (for testing)
    socket.on("forceStartGame", async ({ gameId }) => {
        const strGameId = String(gameId);
        
        if (gameQueues[strGameId] && gameQueues[strGameId].length >= 2 && !activeGames[strGameId]) {
            await startNextGame(strGameId, io, redis);
        } else {
            console.log(`❌ Cannot force start game ${strGameId}. Requirements not met.`);
            socket.emit("forceStartGameFailed", {
                message: `Cannot start game. Queue: ${gameQueues[strGameId]?.length || 0}, Active: ${!!activeGames[strGameId]}`
            });
        }
    });

    // ✅ NEW: Game completed event
    socket.on("gameCompleted", async ({ gameId, GameSessionId }) => {
        const strGameId = String(gameId);
        
        if (activeGames[strGameId] && activeGames[strGameId].GameSessionId === GameSessionId) {
            console.log(`🎉 Game ${strGameId} completed early, cleaning up`);
            await cleanupFinishedGame(strGameId, io, redis);
        }
    });
 
    const clearUserReservations = async (playerIds) => {
        if (!playerIds || playerIds.length === 0) return;

        try {
            await User.updateMany(
                { telegramId: { $in: playerIds } },
                { $unset: { reservedForGameId: "" } }
            );
            console.log(`✅ Reservations cleared for ${playerIds.length} players.`);
        } catch (error) {
            console.error("❌ Error clearing user reservations:", error);
        }
    };

 const HOUSE_CUT_PERCENTAGE = 0.20;
 const MIN_PLAYERS_TO_START = 2;

socket.on("gameCount", async ({ gameId, GameSessionId }) => {
    const strGameId = String(gameId);
    const strGameSessionId = String(GameSessionId);

    console.log("gameCount gamesessionId", GameSessionId);

     if (state.countdownIntervals[strGameId]) {
        console.log(`⏳ Countdown for game ${strGameId} is already running. Ignoring new 'gameCount' trigger.`);
        return;
    }

    try {
        // --- 1. PRE-VALIDATION & LOCK ACQUISITION ---
        if (await isGameLockedOrActive(strGameId, redis, state)) {
            console.log(`⚠️ Game ${strGameId} is already active or locked. Ignoring gameCount event.`);
            return;
        }

        await acquireGameLock(strGameId, redis, state);
        console.log(`🚀 Acquired lock for game ${strGameId}.`);

        const currentGameControl = await GameControl.findOne({ GameSessionId: strGameSessionId });
        if (!currentGameControl || currentGameControl.players.length < MIN_PLAYERS_TO_START) {
            console.log(`🛑 Not enough players to start game ${strGameId}. Found: ${currentGameControl?.players.length || 0}`);
            io.to(strGameId).emit("gameNotStarted", { message: "Not enough players to start the game." });
            await fullGameCleanup(strGameId, redis, state);
            return;
        }
        
        // --- 2. INITIAL GAME SETUP ---
        await prepareNewGame(strGameId, strGameSessionId, redis, state);
        
        // --- 3. START COUNTDOWN ---
        let countdownValue = 30;
        io.to(strGameId).emit("countdownTick", { countdown: countdownValue });
        await redis.set(getCountdownKey(strGameId), countdownValue.toString());

        state.countdownIntervals[strGameId] = setInterval(async () => {
            if (countdownValue > 0) {
                countdownValue--;
                io.to(strGameId).emit("countdownTick", { countdown: countdownValue });
                await redis.set(getCountdownKey(strGameId), countdownValue.toString());
            } else {
                clearInterval(state.countdownIntervals[strGameId]);
                delete state.countdownIntervals[strGameId];
                await redis.del(getCountdownKey(strGameId));

                await processDeductionsAndStartGame(strGameId, strGameSessionId, io, redis, state);
            }
        }, 1000);

    } catch (err) {
        console.error(`❌ Fatal error in gameCount for ${strGameId}:`, err);
        io.to(strGameId).emit("gameNotStarted", { message: "Error during game setup." });
        await fullGameCleanup(strGameId, redis, state);
    }
});

// --- HELPER FUNCTIONS ---
async function isGameLockedOrActive(gameId, redis, state) {
    const [redisHasLock, redisIsActive] = await Promise.all([
        redis.get(getActiveDrawLockKey(gameId)),
        redis.get(getGameActiveKey(gameId))
    ]);
    return state.activeDrawLocks[gameId] || redisHasLock === "true" || redisIsActive === "true";
}

async function acquireGameLock(gameId, redis, state) {
    state.activeDrawLocks[gameId] = true;
    await redis.set(getActiveDrawLockKey(gameId), "true");
}

async function prepareNewGame(gameId, gameSessionId, redis, state) {
    const numbers = Array.from({ length: 75 }, (_, i) => i + 1).sort(() => Math.random() - 0.5);
    await redis.set(getGameDrawStateKey(gameSessionId), JSON.stringify({ numbers, index: 0 }));
    await Promise.all([
        redis.del(getGameActiveKey(gameId)),
        redis.del(getGameDrawsKey(gameSessionId)),
    ]);
}

async function processDeductionsAndStartGame(strGameId, strGameSessionId, io, redis, state) {
    const currentGameControl = await GameControl.findOne({ GameSessionId: strGameSessionId }).select('players -_id');
    const connectedPlayers = (currentGameControl?.players || []).filter(p => p.status === 'connected');
    const playersForDeduction = connectedPlayers.map(player => player?.telegramId).filter(Boolean);
    console.log("player connected are 🤑🤑", playersForDeduction);
    let successfulDeductions = 0;
    let finalPlayerObjects = [];
    let successfullyDeductedPlayers = [];
    const stakeAmount = Number(strGameId);

    if (playersForDeduction.length < MIN_PLAYERS_TO_START) {
        console.log(`🛑 Not enough players after countdown. Aborting.`);
        io.to(strGameId).emit("gameNotStarted", { message: "Not enough players to start." });
        await fullGameCleanup(strGameId, redis, state);
        return;
    }

    // --- Stake Deduction Loop ---
    for (const playerTelegramId of playersForDeduction) {
        try {
            let user = null;
            let deductionSuccessful = false;

            user = await User.findOneAndUpdate(
                { telegramId: playerTelegramId, reservedForGameId: strGameId, bonus_balance: { $gte: stakeAmount } },
                { $inc: { bonus_balance: -stakeAmount }, $unset: { reservedForGameId: "" } },
                { new: true }
            );

            if (user) {
                deductionSuccessful = true;
                await Ledger.create({
                    gameSessionId: strGameSessionId,
                    amount: -stakeAmount,
                    transactionType: 'bonus_stake_deduction',
                    telegramId: playerTelegramId,
                    description: `Bonus stake deduction for game session ${strGameSessionId}`
                });
            } else {
                user = await User.findOneAndUpdate(
                    { telegramId: playerTelegramId, reservedForGameId: strGameId, balance: { $gte: stakeAmount } },
                    { $inc: { balance: -stakeAmount }, $unset: { reservedForGameId: "" } },
                    { new: true }
                );

                if (user) {
                    deductionSuccessful = true;
                    await Ledger.create({
                        gameSessionId: strGameSessionId,
                        amount: -stakeAmount,
                        transactionType: 'stake_deduction',
                        telegramId: playerTelegramId,
                        description: `Stake deduction from main balance for game session ${strGameSessionId}`
                    });
                }
            }

            if (deductionSuccessful) {
                successfulDeductions++;
                successfullyDeductedPlayers.push(playerTelegramId);
                finalPlayerObjects.push({ telegramId: playerTelegramId, status: 'connected' });
                await redis.set(`userBalance:${playerTelegramId}`, user.balance.toString(), "EX", 60);
                await redis.set(`userBonusBalance:${playerTelegramId}`, user.bonus_balance.toString(), "EX", 60);
            } else {
                await User.updateOne({ telegramId: playerTelegramId }, { $unset: { reservedForGameId: "" } });
                await redis.sRem(getGameRoomsKey(strGameId), playerTelegramId.toString());
                await GameControl.updateOne({ GameSessionId: strGameSessionId }, { $pull: { players: { telegramId: playerTelegramId } } });
                console.log(`🛑 User ${playerTelegramId} did not have sufficient funds (bonus or real). Skipping.`);
            }
        } catch (error) {
            console.error(`❌ Error deducting balance for player ${playerTelegramId}:`, error);
            await User.updateOne({ telegramId: playerTelegramId }, { $unset: { reservedForGameId: "" } });
        }
    }
    
    if (successfulDeductions < MIN_PLAYERS_TO_START) {
        console.log("🛑 Not enough players after deductions. Refunding stakes.");
        await refundStakes(successfullyDeductedPlayers, strGameSessionId, stakeAmount, redis);
        io.to(strGameId).emit("gameNotStarted", { message: "Not enough players. Your stake has been refunded." });
        await fullGameCleanup(strGameId, redis, state);
        return;
    }

    const activePlayersKey = `activePlayers:${strGameSessionId}`;
    if (successfullyDeductedPlayers.length > 0) {
        const playerIdsAsStrings = successfullyDeductedPlayers.map(String);
        await redis.sAdd(activePlayersKey, playerIdsAsStrings);
        await redis.expire(activePlayersKey, 3600);
    }

    const totalPot = stakeAmount * successfulDeductions;
    const houseProfit = totalPot * HOUSE_CUT_PERCENTAGE;
    const prizeAmount = totalPot - houseProfit;

    await GameControl.findOneAndUpdate(
        { GameSessionId: strGameSessionId },
        {
            $set: {
                isActive: true,
                totalCards: successfulDeductions,
                prizeAmount: prizeAmount,
                houseProfit: houseProfit,
                players: finalPlayerObjects
            }
        }
    );
    await syncGameIsActive(strGameId, true);

    delete state.activeDrawLocks[strGameId];
    await redis.del(getActiveDrawLockKey(strGameId));

    console.log(`🧹 Releasing all selected cards for game ${strGameId}...`);
    const gameCardsKey = `gameCards:${strGameId}`;

    try {
        const allSelectedCards = await redis.hGetAll(gameCardsKey);
        await redis.del(gameCardsKey);
        await GameCard.updateMany(
            { gameId: strGameId, cardId: { $in: Object.keys(allSelectedCards).map(Number) } },
            { $set: { isTaken: false, takenBy: null } }
        );
        io.to(strGameId).emit("gameCardResetOngameStart");
    } catch (error) {
        console.error(`❌ Error releasing cards on game start for game ${strGameId}:`, error);
    }
    console.log(`✅ All cards released for game ${strGameId}.`);

    const totalDrawingLength = 75;

    console.log(`✅ Emitting gameDetails for game ${strGameId}:`, {
        winAmount: prizeAmount,
        playersCount: successfulDeductions,
        stakeAmount: stakeAmount,
        totalDrawingLength: 75,
    });

    io.to(strGameId).emit("gameDetails", {
        winAmount: prizeAmount,
        playersCount: successfulDeductions,
        stakeAmount: stakeAmount,
        totalDrawingLength: totalDrawingLength,
    });

    console.log("⭐⭐ gameDetails emited");

    io.to(strGameId).emit("gameStart", { gameId: strGameId });
    await startDrawing(strGameId, strGameSessionId, io, state, redis);
}

async function refundStakes(playerIds, strGameSessionId, stakeAmount, redis) {
    for (const playerId of playerIds) {
        try {
            const deductionRecord = await Ledger.findOne({
                telegramId: playerId,
                gameSessionId: strGameSessionId,
                transactionType: { $in: ['stake_deduction', 'bonus_stake_deduction'] }
            });

            let updateQuery;
            let refundTransactionType;
            let wasBonus = false;

            if (deductionRecord && deductionRecord.transactionType === 'bonus_stake_deduction') {
                updateQuery = { $inc: { bonus_balance: stakeAmount }, $unset: { reservedForGameId: "" } };
                refundTransactionType = 'bonus_stake_refund';
                wasBonus = true;
                console.log(`Player ${playerId} paid with bonus. Preparing bonus refund.`);
            } else {
                updateQuery = { $inc: { balance: stakeAmount }, $unset: { reservedForGameId: "" } };
                refundTransactionType = 'stake_refund';
                 if (!deductionRecord) {
                    console.warn(`⚠️ Ledger record not found for player ${playerId}. Defaulting to main balance refund.`);
                }
            }

            const refundedUser = await User.findOneAndUpdate({ telegramId: playerId }, updateQuery, { new: true });

            if (refundedUser) {
                if (wasBonus) {
                    await redis.set(`userBonusBalance:${playerId}`, refundedUser.bonus_balance.toString(), "EX", 60);
                } else {
                    await redis.set(`userBalance:${playerId}`, refundedUser.balance.toString(), "EX", 60);
                }

                await Ledger.create({
                    gameSessionId: strGameSessionId,
                    amount: stakeAmount,
                    transactionType: refundTransactionType,
                    telegramId: playerId,
                    description: `Stake refund for cancelled game session ${strGameSessionId}`
                });
                console.log(`✅ Successfully refunded ${stakeAmount} to ${wasBonus ? 'bonus' : 'main'} balance for player ${playerId}.`);
            } else {
                console.error(`❌ Could not find user ${playerId} to process refund.`);
            }

        } catch (error) {
            console.error(`❌ Error processing refund for player ${playerId}:`, error);
        }
    }
}

async function fullGameCleanup(gameId, redis, state) {
    console.log("fullGameCleanup 🔥🔥🔥");
    delete state.activeDrawLocks[gameId];
    await redis.del(getActiveDrawLockKey(gameId));
    await syncGameIsActive(gameId, false);
    if (state.countdownIntervals[gameId]) { clearInterval(state.countdownIntervals[gameId]); delete state.countdownIntervals[gameId]; }
}

async function startDrawing(gameId, GameSessionId, io, state, redis) {
    const strGameId = String(gameId);
    const strGameSessionId = String(GameSessionId);
    const gameDrawStateKey = getGameDrawStateKey(strGameSessionId);
    const gameDrawsKey = getGameDrawsKey(strGameSessionId);
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

                await resetRound(strGameId, GameSessionId, socket, io, state, redis);

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

                await resetRound(strGameId, GameSessionId, socket, io, state, redis);

                io.to(strGameId).emit("gameEnded", { gameId: strGameId, message: "All numbers drawn, game ended." });
                return;
            }

            const number = gameData.numbers[gameData.index];
            gameData.index += 1;

            const callNumberLength = await redis.rPush(gameDrawsKey, number.toString());

            gameData.callNumberLength = callNumberLength;

            await redis.set(gameDrawStateKey, JSON.stringify(gameData));

            const letterIndex = Math.floor((number - 1) / 15);
            const letter = ["B", "I", "N", "G", "O"][letterIndex];
            const label = `${letter}-${number}`;

            console.log(`🔢 Drawing number: ${label}, Index: ${gameData.index - 1}`);

            io.to(strGameId).emit("numberDrawn", { number, label, gameId: strGameId, callNumberLength: callNumberLength });

        } catch (error) {
            console.error(`❌ Error during drawing interval for game ${strGameId}:`, error);
            clearInterval(state.drawIntervals[strGameId]);
            delete state.drawIntervals[strGameId];
            await resetRound(strGameId, GameSessionId, socket, io, state, redis);
            io.to(strGameId).emit("gameEnded", { gameId: strGameId, message: "Game ended due to drawing error." });
        }
    }, 3000);
}

socket.on("checkWinner", async ({ telegramId, gameId, GameSessionId, cartelaId, selectedNumbers }) => {
  console.time(`⏳checkWinner_${telegramId}`);

  try {
    const selectedSet = new Set((selectedNumbers || []).map(Number));
    const numericCardId = Number(cartelaId);
    if (isNaN(numericCardId)) {
      return socket.emit("winnerError", { message: "Invalid card ID." });
    }

    const drawnNumbersRaw = await redis.lRange(`gameDraws:${GameSessionId}`, 0, -1);
    if (!drawnNumbersRaw?.length) return socket.emit("winnerError", { message: "No numbers drawn yet." });
    const drawnNumbersArray = drawnNumbersRaw.map(Number);
    const lastTwoDrawnNumbers = drawnNumbersArray.slice(-2);
    const drawnNumbers = new Set(drawnNumbersArray);

    const cardData = await GameCard.findOne({ gameId, cardId: numericCardId });
    if (!cardData) return socket.emit("winnerError", { message: "Card not found." });

    const pattern = checkBingoPattern(cardData.card, drawnNumbers, selectedSet);
    if (!pattern.some(Boolean)) return socket.emit("winnerError", { message: "No winning pattern." });

    const flatCard = cardData.card.flat();
    const isRecentNumberInPattern = lastTwoDrawnNumbers.some(num =>
      flatCard.some((n, i) => pattern[i] && n === num)
    );
    if (!isRecentNumberInPattern) {
      return socket.emit("bingoClaimFailed", {
        message: "Winning pattern not completed by recent numbers.",
        telegramId, gameId, cardId: cartelaId, card: cardData.card, lastTwoNumbers: lastTwoDrawnNumbers, selectedNumbers
      });
    }

    const winnerLockKey = `winnerLock:${GameSessionId}`;
    const lockAcquired = await redis.set(winnerLockKey, telegramId, { NX: true, EX: 30 });
    if (!lockAcquired) return;

    await processWinner({
      telegramId, gameId, GameSessionId, cartelaId, io, selectedSet, state, redis, cardData, drawnNumbersRaw, winnerLockKey
    });

  } catch (error) {
    console.error("checkWinner error:", error);
    socket.emit("winnerError", { message: "Internal error." });
  } finally {
    console.timeEnd(`⏳checkWinner_${telegramId}`);
  }
});

async function processWinner({ telegramId, gameId, GameSessionId, cartelaId, io, selectedSet, state, redis, cardData, drawnNumbersRaw, winnerLockKey }) {
  const strGameId = String(gameId);
  const strGameSessionId = String(GameSessionId);

  try {
    const [gameControl, winnerUser, gameDrawStateRaw, players] = await Promise.all([
      GameControl.findOne({ GameSessionId: strGameSessionId }),
      User.findOne({ telegramId }),
      redis.get(`gameDrawState:${strGameSessionId}`), 
      redis.sMembers(`gameRooms:${strGameId}`)
    ]);

    if (!gameControl || !winnerUser) throw new Error("Missing game or user data");

    const { prizeAmount, houseProfit, stakeAmount, totalCards: playerCount } = gameControl;
    const board = cardData.card;
    const winnerPattern = checkBingoPattern(board, new Set(drawnNumbersRaw.map(Number)), selectedSet);
    const callNumberLength = gameDrawStateRaw ? JSON.parse(gameDrawStateRaw)?.callNumberLength || 0 : 0;

    io.to(strGameId).emit("winnerConfirmed", { winnerName: winnerUser.username || "Unknown", prizeAmount, playerCount, boardNumber: cartelaId, board, winnerPattern, telegramId, gameId: strGameId, GameSessionId: strGameSessionId });

    await Promise.all([
      User.updateOne({ telegramId }, { $inc: { balance: prizeAmount } }),
      redis.incrByFloat(`userBalance:${telegramId}`, prizeAmount),
      Ledger.create({ gameSessionId: strGameSessionId, amount: prizeAmount, transactionType: 'player_winnings', telegramId }),
      Ledger.create({ gameSessionId: strGameSessionId, amount: houseProfit, transactionType: 'house_profit' }),
      GameHistory.create({ sessionId: strGameSessionId, gameId: strGameId, username: winnerUser.username || "Unknown", telegramId, eventType: "win", winAmount: prizeAmount, stake: stakeAmount, cartelaId, callNumberLength })
    ]);

    (async () => {
      try {
        const loserIds = players.filter(id => id !== telegramId).map(Number);
        if (loserIds.length > 0) {
          const [loserUsers, loserCards] = await Promise.all([
            User.find({ telegramId: { $in: loserIds } }, 'telegramId username'),
            GameCard.find({ gameId: strGameId, takenBy: { $in: loserIds } }, 'takenBy cardId')
          ]);
          
          const userMap = new Map(loserUsers.map(u => [u.telegramId, u]));
          const cardMap = new Map(loserCards.map(c => [c.takenBy, c]));

          const loserDocs = loserIds.map(id => ({
            sessionId: strGameSessionId,
            gameId: strGameId,
            username: userMap.get(id)?.username || "Unknown",
            telegramId: id,
            eventType: "lose",
            winAmount: 0,
            stake: stakeAmount,
            cartelaId: cardMap.get(id)?.cardId || null,
            callNumberLength,
            createdAt: new Date()
          }));

          await GameHistory.insertMany(loserDocs);
        }

        const cleanupTasks = [
          GameControl.findOneAndUpdate({ GameSessionId: strGameSessionId }, { isActive: false, endedAt: new Date() }),
          syncGameIsActive(strGameId, false),
          redis.set(`winnerInfo:${strGameSessionId}`, JSON.stringify({ winnerName: winnerUser.username || "Unknown", prizeAmount, playerCount, boardNumber: cartelaId, board, winnerPattern, telegramId, gameId: strGameId }), { EX: 300 }),
          resetRound(strGameId, strGameSessionId, socket, io, state, redis)
        ];
        
        GameCard.updateMany({ gameId: strGameId }, { isTaken: false, takenBy: null }).catch(err => console.error("Async Card Reset Error:", err));

        const redisPipeline = redis.multi();
        redisPipeline.del(
          `gameRooms:${strGameId}`,
          `gameCards:${strGameId}`,
          `gameDraws:${strGameSessionId}`,
          `gameActive:${strGameId}`,
          `countdown:${strGameId}`,
          `activeDrawLock:${strGameId}`,
          `gameDrawState:${strGameSessionId}`,
          winnerLockKey
        );
        cleanupTasks.push(redisPipeline.exec());

        await Promise.all(cleanupTasks);
        
        io.to(strGameId).emit("gameEnded");

      } catch (error) {
        console.error("🔥 Deferred Cleanup Error:", error);
      }
    })();

  } catch (error) {
    console.error("🔥 processWinnerOptimized error:", error);
    await redis.del(winnerLockKey).catch(err => console.error("Lock release error:", err));
  }
}

socket.on("playerLeave", async ({ gameId, GameSessionId, telegramId }, callback) => {
    const strTelegramId = String(telegramId);
    const strGameId = String(gameId);
    console.log(`🚪 Player ${telegramId} is leaving game ${gameId} ${GameSessionId}`);

    try {
        // ✅ NEW: Remove player from queue
        removeFromQueue(strGameId, strTelegramId, io);

        const userUpdateResult = await User.updateOne(
            { telegramId: strTelegramId, reservedForGameId: strGameId },
            { $unset: { reservedForGameId: "" } }
        );

        if (userUpdateResult.modifiedCount > 0) {
            console.log(`✅ Balance reservation lock for player ${telegramId} released.`);
        } else {
            console.log(`⚠️ No balance reservation lock found for player ${telegramId}.`);
        }

        await GameControl.updateOne(
            { GameSessionId: GameSessionId },
            { $pull: { players: { telegramId: strTelegramId } } }
        );
        console.log(`✅ Player ${telegramId} removed from GameControl document.`);

        await Promise.all([
            redis.sRem(`gameSessions:${gameId}`, strTelegramId),
            redis.sRem(`gameRooms:${gameId}`, strTelegramId),
        ]);

        let userSelectionRaw = await redis.hGet("userSelectionsByTelegramId", strTelegramId);
        let userSelection = userSelectionRaw ? JSON.parse(userSelectionRaw) : null;

        if (userSelection?.cardId) {
            const cardOwner = await redis.hGet(`gameCards:${gameId}`, String(userSelection.cardId));
            if (cardOwner === strTelegramId) {
                const dbUpdateResult = await GameCard.findOneAndUpdate(
                    { gameId, cardId: Number(userSelection.cardId) },
                    { isTaken: false, takenBy: null }
                );

                if (dbUpdateResult) {
                    console.log(`✅ DB updated: Card ${userSelection.cardId} released for ${telegramId}`);
                } else {
                    console.warn(`⚠️ DB update failed: Could not find card ${userSelection.cardId} to release`);
                }

                io.to(gameId).emit("cardAvailable", { cardId: userSelection.cardId });
                console.log(`✅ Emitted 'cardAvailable' for card ${userSelection.cardId}`);

                await redis.hDel(`gameCards:${gameId}`, userSelection.cardId);
            }
        }

        await Promise.all([
            redis.hDel("userSelections", socket.id),
            redis.hDel("userSelections", strTelegramId),
            redis.hDel("userSelectionsByTelegramId", strTelegramId),
            redis.sRem(getGameRoomsKey(gameId), strTelegramId),
            deleteCardsByTelegramId(strGameId, strTelegramId),
            redis.del(`activeSocket:${strTelegramId}:${socket.id}`),
        ]);

        const playerCount = await redis.sCard(`gameRooms:${gameId}`) || 0;
        io.to(gameId).emit("playerCountUpdate", { gameId, playerCount });

        await checkAndResetIfEmpty(gameId, GameSessionId, socket, io, redis, state);

        if (callback) callback();
    } catch (error) {
        console.error("❌ Error handling playerLeave:", error);
        if (callback) callback();
    }
});

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

socket.on("disconnect", async (reason) => {
    console.log(`🔴 Client disconnected: ${socket.id}, Reason: ${reason}`);

    try {
        let userPayload = null;
        let disconnectedPhase = null;
        let strTelegramId = null;
        let strGameId = null;
        let strGameSessionId = null;
        let gameSessionId = null;

        const [userSelectionPayloadRaw, joinGamePayloadRaw] = await redis.multi()
            .hGet("userSelections", socket.id)
            .hGet("joinGameSocketsInfo", socket.id)
            .exec();

     if (joinGamePayloadRaw) {
        try {
            payload = JSON.parse(joinGamePayloadRaw);
            gameSessionId = payload?.GameSessionId ? String(payload.GameSessionId) : null;
        } catch (err) {
            console.warn("⚠️ Failed to parse joinGamePayloadRaw", joinGamePayloadRaw, err);
        }
     }

        if (userSelectionPayloadRaw) {
            userPayload = safeJsonParse(userSelectionPayloadRaw, "userSelections", socket.id);
            if (userPayload) {
                disconnectedPhase = userPayload.phase || 'lobby';
            } else {
                await redis.hDel("userSelections", socket.id);
            }
        }

        if (!userPayload && joinGamePayloadRaw) {
            userPayload = safeJsonParse(joinGamePayloadRaw, "joinGameSocketsInfo", socket.id);
            if (userPayload) {
                disconnectedPhase = userPayload.phase || 'joinGame';
            } else {
                await redis.hDel("joinGameSocketsInfo", socket.id);
            }
        }

        if (!userPayload || !userPayload.telegramId || !userPayload.gameId || !disconnectedPhase) {
            console.log("❌ No relevant user session info found or payload corrupted for this disconnected socket ID. Skipping full disconnect cleanup.");
            await redis.del(`activeSocket:${socket.handshake.query.telegramId || 'unknown'}:${socket.id}`);
            return;
        }

        strTelegramId = String(userPayload.telegramId);
        strGameId = String(userPayload.gameId);
        strGameSessionId = userPayload.GameSessionId|| gameSessionId || 'NO_SESSION_ID';

        console.log(`[DISCONNECT DEBUG] Processing disconnect for User: ${strTelegramId}, Game: ${strGameId}, Socket: ${socket.id}, Final Deduced Phase: ${disconnectedPhase}`);

        // ✅ NEW: Remove from queue on disconnect
        removeFromQueue(strGameId, strTelegramId, io);

        await redis.del(`activeSocket:${strTelegramId}:${socket.id}`);

        const allActiveSocketKeysForUser = await redis.keys(`activeSocket:${strTelegramId}:*`);
        const otherSocketIds = allActiveSocketKeysForUser
            .map(key => key.split(':').pop())
            .filter(id => id !== socket.id);

        const otherSocketPayloadsRaw = otherSocketIds.length > 0 ?
            await redis.multi(otherSocketIds.map(id => [
                'hGet',
                disconnectedPhase === 'lobby' ? 'userSelections' : 'joinGameSocketsInfo',
                id
            ])).exec() : [];

        let remainingSocketsForThisPhaseCount = 0;
        let staleKeysToDelete = [];

        for (let i = 0; i < otherSocketIds.length; i++) {
            const otherSocketId = otherSocketIds[i];
            const payload = otherSocketPayloadsRaw[i] && otherSocketPayloadsRaw[i][1];

            const otherSocketInfo = safeJsonParse(payload, 'otherSocket', otherSocketId);

            if (otherSocketInfo && String(otherSocketInfo.gameId) === strGameId && (otherSocketInfo.phase || 'lobby') === disconnectedPhase) {
                remainingSocketsForThisPhaseCount++;
            } else {
                staleKeysToDelete.push(`activeSocket:${strTelegramId}:${otherSocketId}`];
            }
        }

        if (staleKeysToDelete.length > 0) {
            await redis.del(...staleKeysToDelete);
            console.log(`🧹 Cleaned up ${staleKeysToDelete.length} stale activeSocket keys.`);
        }

        console.log(`[DISCONNECT DEBUG] Remaining active sockets for ${strTelegramId} in game ${strGameId} in phase '${disconnectedPhase}': ${remainingSocketsForThisPhaseCount}`);

        const timeoutKeyForPhase = `${strTelegramId}:${strGameId}:${disconnectedPhase}`;

        if (pendingDisconnectTimeouts.has(timeoutKeyForPhase)) {
            clearTimeout(pendingDisconnectTimeouts.get(timeoutKeyForPhase));
            pendingDisconnectTimeouts.delete(timeoutKeyForPhase);
            console.log(`🕒 Cleared existing pending disconnect timeout for ${timeoutKeyForPhase}.`);
        }

        if (remainingSocketsForThisPhaseCount === 0) {
            let cleanupFunction;
            let gracePeriodDuration;

            if (disconnectedPhase === 'lobby') {
                cleanupFunction = cleanupLobbyPhase;
                gracePeriodDuration = ACTIVE_DISCONNECT_GRACE_PERIOD_MS;
            } else if (disconnectedPhase === 'joinGame') {
                cleanupFunction = cleanupJoinGamePhase;
                gracePeriodDuration = JOIN_GAME_GRACE_PERIOD_MS;
            }

            if (cleanupFunction) {
                const timeoutId = setTimeout(async () => {
                    try {
                            console.log(`[DEBUG] Attempting to update GameSessionId: ${gameSessionId} for player: ${strTelegramId}`);
                            console.log("reason", reason, "inside cleanupfunction", strTelegramId, "➖➖");
                           if (gameSessionId) {
                            const result = await GameControl.updateOne(
                                { GameSessionId: gameSessionId, 'players.telegramId': Number(strTelegramId) }, 
                                { '$set': { 'players.$.status': 'disconnected' } }
                            );
                            console.log(`✅ Player ${strTelegramId} status updated to 'disconnected'. Result:`, result);

                        const userUpdateResult = await User.findOneAndUpdate(
                            { telegramId: Number(strTelegramId) },
                            { $set: { reservedForGameId: null } }
                        );
                          console.log(`👴 Player ${strTelegramId} reservedGameId`, userUpdateResult);

                        }
                        await cleanupFunction(strTelegramId, strGameId, strGameSessionId, io, redis);
                         const game = await GameControl.findOne({ GameSessionId: gameSessionId });

                     if (game && game.players.every(player => player.status === 'disconnected')) {
                            await GameControl.updateOne(
                                { GameSessionId: gameSessionId },
                                { 
                                    '$set': { 
                                        'isActive': false, 
                                        'endedAt': new Date() 
                                    } 
                                }
                            );
                            console.log(`❗ Game ${game.gameId} has ended due to all players disconnecting.`);

                            await resetRound(strGameId, gameSessionId, socket, io, state, redis);

                            io.to(strGameId).emit("gameEnded", { gameId: strGameId, message: "Game ended due to all players leaving the room." });
                            console.log("🛑🛑 game is cleared in disconnect after all players leave");
                        }
                    } catch (e) {
                        console.error(`❌ Error during grace period cleanup for ${timeoutKeyForPhase}:`, e);
                    } finally {
                        pendingDisconnectTimeouts.delete(timeoutKeyForPhase);
                    }
                }, gracePeriodDuration);

                pendingDisconnectTimeouts.set(timeoutKeyForPhase, timeoutId);
                console.log(`🕒 User ${strTelegramId} has no remaining active sockets for game ${strGameId} in '${disconnectedPhase}' phase. Starting ${gracePeriodDuration / 1000}-second grace period timer.`);
            }
        } else {
            console.log(`ℹ️ ${strTelegramId} still has ${remainingSocketsForThisPhaseCount} other active sockets for game ${strGameId} in phase '${disconnectedPhase}'. No grace period timer started for this phase.`);
        }
    } catch (e) {
        console.error(`❌ CRITICAL ERROR in disconnect handler for socket ${socket.id}:`, e);
    }
});

const cleanupLobbyPhase = async (strTelegramId, strGameId, strGameSessionId, io, redis) => {
    console.log(`⏱️ Lobby grace period expired for User: ${strTelegramId}, Game: ${strGameId}. Performing cleanup.`);

    const gameCardsKey = `gameCards:${strGameId}`;

    const userOverallSelectionRaw = await redis.hGet("userSelectionsByTelegramId", strTelegramId);
    let userHeldCardId = null;
    if (userOverallSelectionRaw) {
        const parsed = safeJsonParse(userOverallSelectionRaw);
        if (parsed?.cardId) userHeldCardId = parsed.cardId;
    }

    const dbCard = await GameCard.findOne({ gameId: strGameId, takenBy: strTelegramId });

    if (userHeldCardId || dbCard) {
        const cardToRelease = userHeldCardId || dbCard.cardId;
        await redis.hDel(gameCardsKey, String(cardToRelease));
        await GameCard.findOneAndUpdate(
            { gameId: strGameId, cardId: Number(cardToRelease) },
            { isTaken: false, takenBy: null }
        );
        io.to(strGameId).emit("cardReleased", { cardId: Number(cardToRelease), telegramId: strTelegramId });
        console.log(`✅ Card ${cardToRelease} released for ${strTelegramId} due to grace period expiry.`);
    }

    await redis.multi()
        .sRem(`gameSessions:${strGameId}`, strTelegramId)
        .sRem(`gamePlayers:${strGameId}`, strTelegramId)
        .hDel("userSelectionsByTelegramId", strTelegramId)
        .exec();

    const numberOfPlayersLobby = await redis.sCard(`gameSessions:${strGameId}`) || 0;
    io.to(strGameId).emit("gameid", { gameId: strGameId, numberOfPlayers: numberOfPlayersLobby });

    const totalPlayersGamePlayers = await redis.sCard(`gamePlayers:${strGameId}`);
    if (numberOfPlayersLobby === 0 && totalPlayersGamePlayers === 0) {
        await GameControl.findOneAndUpdate({ gameId: strGameId }, { isActive: false, totalCards: 0, players: [], endedAt: new Date() });
        await syncGameIsActive(strGameId, false);
        resetGame(strGameId, strGameSessionId, io, state, redis);
        console.log(`🧹 Game ${strGameId} fully reset.`);
    }
};

const cleanupJoinGamePhase = async (strTelegramId, strGameId, strGameSessionId, io, redis) => {
    let retries = 3;

    while (retries > 0) {
        try {
            console.log(`⏱️ JoinGame grace period expired for User: ${strTelegramId}, Game: ${strGameId}. Performing joinGame-specific cleanup.`);

            const gameControl = await GameControl.findOneAndUpdate(
                { GameSessionId: strGameSessionId, 'players.telegramId': Number(strTelegramId) },
                { $set: { 'players.$.status': 'disconnected' } },
                { new: true, upsert: false }
            );

            if (gameControl) {
                 console.log("🕸️🕸️🏠 player status updated to 'disconnected'", strGameId, strTelegramId);
            } else {
                 console.warn(`GameControl document or player not found for cleanup: ${strGameId} (Session: ${strGameSessionId})`);
            }

            break;
        } catch (e) {
            if (e.name === 'VersionError') {
                console.warn(`Version conflict detected during cleanup for ${strTelegramId}:${strGameId}. Retrying... (${retries - 1} left)`);
                retries--;
                continue;
            } else {
                console.error(`❌ CRITICAL ERROR during grace period cleanup for ${strTelegramId}:${strGameId}:`, e);
                throw e;
            }
        }
    }

    await redis.sRem(`gameRooms:${strGameId}`, strTelegramId);
    console.log("➖➖ remove player from the gameroom redis",`gameRooms:${strGameId}`);

    const playerCount = await redis.sCard(`gameRooms:${strGameId}`);
    io.to(strGameId).emit("playerCountUpdate", { gameId: strGameId, playerCount });
    console.log(`📊 Broadcasted counts for game ${strGameId}: Total Players = ${playerCount} after joinGame grace period cleanup.`);

    const userOverallSelectionRaw = await redis.hGet("userSelectionsByTelegramId", strTelegramId);
    if (userOverallSelectionRaw) {
        const { cardId: userHeldCardId, gameId: selectedGameId } = safeJsonParse(userOverallSelectionRaw);
        if (String(selectedGameId) === strGameId && userHeldCardId) {
            const gameCardsKey = `gameCards:${strGameId}`;
            const cardOwner = await redis.hGet(gameCardsKey, String(userHeldCardId));
            if (cardOwner === strTelegramId) {
                await redis.hDel(gameCardsKey, String(userHeldCardId));
                await GameCard.findOneAndUpdate({ gameId: strGameId, cardId: Number(userHeldCardId) }, { isTaken: false, takenBy: null });
                io.to(strGameId).emit("cardReleased", { cardId: Number(userHeldCardId), telegramId: strTelegramId });
                console.log(`✅ Card ${userHeldCardId} released for ${strTelegramId} (disconnected from joinGame).`);
            }
        }
    }
    await redis.hDel("userSelectionsByTelegramId", strTelegramId);

    await User.findOneAndUpdate({ telegramId: strTelegramId, reservedForGameId: strGameId }, { $unset: { reservedForGameId: "" } });

    if (playerCount === 0) {
        console.log(`✅ All players have left game room ${strGameId}. Calling resetRound.`);
        resetRound(strGameId, strGameSessionId, socket, io, state, redis);
    }

    const totalPlayersGamePlayers = await redis.sCard(`gamePlayers:${strGameId}`);
    const numberOfPlayersLobby = await redis.sCard(`gameSessions:${strGameId}`) || 0;
    if (playerCount === 0 && numberOfPlayersLobby === 0 && totalPlayersGamePlayers === 0) {
        console.log(`🧹 Game ${strGameId} empty after joinGame phase grace period. Triggering full game reset.`);
            await GameControl.findOneAndUpdate(
            { gameId: strGameId, GameSessionId: strGameSessionId },
            {
                $set: {
                isActive: false,
                totalCards: 0,
                players: [],
                endedAt: new Date(),
                }
            }
            );
        await syncGameIsActive(strGameId, false);
        resetGame(strGameId,strGameSessionId, io, state, redis);
        console.log(`Game ${strGameId} has been fully reset.`);
    }
};

  });
};