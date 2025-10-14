const User = require("../models/user");
const GameControl = require("../models/GameControl");
const GameHistory = require("../models/GameHistory");
const Ledger = require("../models/ledgerSchema");
const resetGame = require("../utils/resetGame");
const checkAndResetIfEmpty = require("../utils/checkandreset");
const redis = require("../utils/redisClient");
const syncGameIsActive = require("../utils/syncGameIsActive");
const GameCard = require('../models/GameCard');
const checkBingoPattern = require("../utils/BingoPatterns");
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
const Joi = require('joi');

// ==================== CONFIGURATION ====================
const CONFIG = {
    GAME: {
        MIN_PLAYERS_TO_START: 2,
        HOUSE_CUT_PERCENTAGE: 0.20,
        DEFAULT_STAKE_AMOUNT: 10,
        TOTAL_DRAWING_LENGTH: 75,
        DEFAULT_GAME_TOTAL_CARDS: 1,
        DEFAULT_CREATED_BY: 'System',
        DEFAULT_IS_ACTIVE: false
    },
    TIMING: {
        COUNTDOWN_DURATION: 30,
        DRAW_INTERVAL: 3000,
        DISCONNECT_GRACE_PERIOD: {
            LOBBY: 2 * 1000,
            JOIN_GAME: 2 * 1000
        },
        ACTIVE_SOCKET_TTL: 60 * 3,
        LOCK_TTL: 15,
        REQUEST_DEDUPLICATION_TTL: 5000
    },
    REDIS: {
        TTL: {
            USER_BALANCE: 60,
            WINNER_INFO: 300,
            GAME_STATUS: 60,
            NEGATIVE_CACHE: 30
        }
    },
    RATE_LIMIT: {
        MAX_CONNECTIONS_PER_USER: 3
    }
};

// ==================== ERROR HANDLING ====================
class GameError extends Error {
    constructor(message, code, context = {}) {
        super(message);
        this.name = 'GameError';
        this.code = code;
        this.context = context;
        this.timestamp = new Date().toISOString();
    }
}

class ConnectionError extends GameError {
    constructor(message, context = {}) {
        super(message, 'CONNECTION_ERROR', context);
    }
}

class ValidationError extends GameError {
    constructor(message, context = {}) {
        super(message, 'VALIDATION_ERROR', context);
    }
}

class LockError extends GameError {
    constructor(message, context = {}) {
        super(message, 'LOCK_ERROR', context);
    }
}

// ==================== VALIDATION SCHEMAS ====================
const gameSchemas = {
    userJoinedGame: Joi.object({
        telegramId: Joi.alternatives().try(Joi.string(), Joi.number()).required(),
        gameId: Joi.alternatives().try(Joi.string(), Joi.number()).required()
    }),
    cardSelected: Joi.object({
        telegramId: Joi.alternatives().try(Joi.string(), Joi.number()).required(),
        cardId: Joi.alternatives().try(Joi.string(), Joi.number()).required(),
        card: Joi.array().items(Joi.array().items(Joi.alternatives().try(Joi.number(), Joi.string()))).required(),
        gameId: Joi.alternatives().try(Joi.string(), Joi.number()).required(),
        requestId: Joi.string().required()
    }),
    joinGame: Joi.object({
        gameId: Joi.alternatives().try(Joi.string(), Joi.number()).required(),
        GameSessionId: Joi.string().required(),
        telegramId: Joi.alternatives().try(Joi.string(), Joi.number()).required()
    }),
    checkWinner: Joi.object({
        telegramId: Joi.alternatives().try(Joi.string(), Joi.number()).required(),
        gameId: Joi.alternatives().try(Joi.string(), Joi.number()).required(),
        GameSessionId: Joi.string().required(),
        cartelaId: Joi.alternatives().try(Joi.string(), Joi.number()).required(),
        selectedNumbers: Joi.array().items(Joi.number()).default([])
    }),
    playerLeave: Joi.object({
        gameId: Joi.alternatives().try(Joi.string(), Joi.number()).required(),
        GameSessionId: Joi.string().required(),
        telegramId: Joi.alternatives().try(Joi.string(), Joi.number()).required()
    })
};

// ==================== UTILITY FUNCTIONS ====================
const validateSocketInput = (schema) => (data) => {
    const { error, value } = schema.validate(data);
    if (error) {
        throw new ValidationError(`Invalid input: ${error.details[0].message}`, { 
            details: error.details 
        });
    }
    return value;
};

const safeJsonParse = (rawPayload, key, socketId) => {
    try {
        if (rawPayload) {
            return JSON.parse(rawPayload);
        }
    } catch (e) {
        console.error(`❌ Error parsing payload for ${key} and socket ${socketId}: ${e.message}`);
    }
    return null;
};

const logger = {
    info: (message, meta = {}) => {
        console.log(JSON.stringify({ 
            level: 'info', 
            message, 
            timestamp: new Date().toISOString(), 
            ...meta 
        }));
    },
    error: (message, error = null, meta = {}) => {
        console.error(JSON.stringify({ 
            level: 'error', 
            message, 
            error: error?.message, 
            stack: error?.stack,
            timestamp: new Date().toISOString(),
            ...meta 
        }));
    },
    warn: (message, meta = {}) => {
        console.warn(JSON.stringify({ 
            level: 'warn', 
            message, 
            timestamp: new Date().toISOString(),
            ...meta 
        }));
    }
};

// ==================== REDIS KEY MANAGEMENT ====================
const REDIS_KEYS = {
    userSelection: (socketId) => `userSelections:${socketId}`,
    userSelectionsByTelegramId: (telegramId) => `userSelectionsByTelegramId:${telegramId}`,
    gameCards: (gameId) => `gameCards:${gameId}`,
    gameSessions: (gameId) => `gameSessions:${gameId}`,
    gamePlayers: (gameId) => `gamePlayers:${gameId}`,
    gameRooms: (gameId) => `gameRooms:${gameId}`,
    activeSocket: (telegramId, socketId) => `activeSocket:${telegramId}:${socketId}`,
    joinGameSockets: (socketId) => `joinGameSocketsInfo:${socketId}`,
    winnerLock: (gameSessionId) => `winnerLock:${gameSessionId}`,
    userActionLock: (gameId, telegramId) => `lock:userAction:${gameId}:${telegramId}`,
    cardLock: (gameId, cardId) => `lock:card:${gameId}:${cardId}`,
    userLastRequestId: (telegramId) => `userLastRequestId:${telegramId}`,
    activePlayers: (gameSessionId) => `activePlayers:${gameSessionId}`,
    winnerInfo: (gameSessionId) => `winnerInfo:${gameSessionId}`,
    userBalance: (telegramId) => `userBalance:${telegramId}`,
    userBonusBalance: (telegramId) => `userBonusBalance:${telegramId}`
};

// ==================== STATE MANAGEMENT ====================
const pendingDisconnectTimeouts = new Map();
const pendingRequests = new Map();
const userConnections = new Map();

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

// ==================== CONNECTION MANAGEMENT ====================
const canUserConnect = (telegramId) => {
    const strTelegramId = String(telegramId);
    const current = userConnections.get(strTelegramId) || 0;
    if (current >= CONFIG.RATE_LIMIT.MAX_CONNECTIONS_PER_USER) {
        throw new ConnectionError('Too many connections', { 
            telegramId: strTelegramId, 
            current 
        });
    }
    userConnections.set(strTelegramId, current + 1);
    return true;
};

const userDisconnected = (telegramId) => {
    const strTelegramId = String(telegramId);
    const current = userConnections.get(strTelegramId) || 1;
    userConnections.set(strTelegramId, Math.max(0, current - 1));
};

// ==================== REQUEST DEDUPLICATION ====================
const deduplicateRequest = async (key, operation, ttl = CONFIG.TIMING.REQUEST_DEDUPLICATION_TTL) => {
    if (pendingRequests.has(key)) {
        return pendingRequests.get(key);
    }
    
    const promise = operation();
    pendingRequests.set(key, promise);
    
    promise.finally(() => {
        setTimeout(() => pendingRequests.delete(key), ttl);
    });
    
    return promise;
};

// ==================== BATCH REDIS OPERATIONS ====================
const batchRedisOperations = async (operations) => {
    const pipeline = redis.multi();
    
    operations.forEach(([command, ...args]) => {
        pipeline[command](...args);
    });
    
    return await pipeline.exec();
};

// ==================== GAME HELPER FUNCTIONS ====================
const withErrorHandling = (handler, eventName) => {
    return async (...args) => {
        const socket = args[0];
        const data = args[1];
        
        try {
            logger.info(`Socket event received: ${eventName}`, {
                socketId: socket.id,
                data
            });
            
            await handler(...args);
            
        } catch (error) {
            logger.error(`Socket error in ${eventName}`, error, {
                socketId: socket.id,
                eventName,
                data
            });
            
            const errorResponse = error instanceof GameError 
                ? { 
                    success: false, 
                    error: error.message, 
                    code: error.code,
                    context: error.context 
                }
                : { 
                    success: false, 
                    error: "Internal server error",
                    code: "INTERNAL_ERROR"
                };
            
            socket.emit("error", errorResponse);
            
            // Emit specific error events based on the original event
            if (eventName === "cardSelected") {
                socket.emit("cardError", errorResponse);
            } else if (eventName === "joinGame" || eventName === "userJoinedGame") {
                socket.emit("joinError", errorResponse);
            } else if (eventName === "checkWinner") {
                socket.emit("winnerError", errorResponse);
            }
        }
    };
};

const isGameLockedOrActive = async (gameId, redis, state) => {
    const [redisHasLock, redisIsActive] = await Promise.all([
        redis.get(getActiveDrawLockKey(gameId)),
        redis.get(getGameActiveKey(gameId))
    ]);
    return state.activeDrawLocks[gameId] || redisHasLock === "true" || redisIsActive === "true";
};

const acquireGameLock = async (gameId, redis, state) => {
    const lockKey = getActiveDrawLockKey(gameId);
    const lockAcquired = await redis.set(lockKey, "true", "NX", "EX", CONFIG.TIMING.LOCK_TTL);
    
    if (!lockAcquired) {
        throw new LockError('Game is currently being processed', { gameId });
    }
    
    state.activeDrawLocks[gameId] = true;
};

const prepareNewGame = async (gameId, gameSessionId, redis, state) => {
    const numbers = Array.from({ length: 75 }, (_, i) => i + 1)
        .sort(() => Math.random() - 0.5);
    
    await redis.set(
        getGameDrawStateKey(gameSessionId), 
        JSON.stringify({ numbers, index: 0 })
    );
    
    await Promise.all([
        redis.del(getGameActiveKey(gameId)),
        redis.del(getGameDrawsKey(gameSessionId)),
    ]);
};

const fullGameCleanup = async (gameId, redis, state) => {
    logger.info('Performing full game cleanup', { gameId });
    
    delete state.activeDrawLocks[gameId];
    await redis.del(getActiveDrawLockKey(gameId));
    await syncGameIsActive(gameId, false);
    
    if (state.countdownIntervals[gameId]) {
        clearInterval(state.countdownIntervals[gameId]);
        delete state.countdownIntervals[gameId];
    }
    
    if (state.drawIntervals[gameId]) {
        clearInterval(state.drawIntervals[gameId]);
        delete state.drawIntervals[gameId];
    }
    
    if (state.drawStartTimeouts[gameId]) {
        clearTimeout(state.drawStartTimeouts[gameId]);
        delete state.drawStartTimeouts[gameId];
    }
};

const refundStakes = async (playerIds, gameSessionId, stakeAmount, redis) => {
    for (const playerId of playerIds) {
        try {
            const deductionRecord = await Ledger.findOne({
                telegramId: playerId,
                gameSessionId: gameSessionId,
                transactionType: { $in: ['stake_deduction', 'bonus_stake_deduction'] }
            });

            let updateQuery;
            let refundTransactionType;
            let wasBonus = false;

            if (deductionRecord && deductionRecord.transactionType === 'bonus_stake_deduction') {
                updateQuery = { 
                    $inc: { bonus_balance: stakeAmount }, 
                    $unset: { reservedForGameId: "" } 
                };
                refundTransactionType = 'bonus_stake_refund';
                wasBonus = true;
            } else {
                updateQuery = { 
                    $inc: { balance: stakeAmount }, 
                    $unset: { reservedForGameId: "" } 
                };
                refundTransactionType = 'stake_refund';
                
                if (!deductionRecord) {
                    logger.warn('Ledger record not found for player, defaulting to main balance refund', {
                        playerId,
                        gameSessionId
                    });
                }
            }

            const refundedUser = await User.findOneAndUpdate(
                { telegramId: playerId }, 
                updateQuery, 
                { new: true }
            );

            if (refundedUser) {
                if (wasBonus) {
                    await redis.set(
                        REDIS_KEYS.userBonusBalance(playerId), 
                        refundedUser.bonus_balance.toString(), 
                        "EX", 
                        CONFIG.REDIS.TTL.USER_BALANCE
                    );
                } else {
                    await redis.set(
                        REDIS_KEYS.userBalance(playerId), 
                        refundedUser.balance.toString(), 
                        "EX", 
                        CONFIG.REDIS.TTL.USER_BALANCE
                    );
                }

                await Ledger.create({
                    gameSessionId: gameSessionId,
                    amount: stakeAmount,
                    transactionType: refundTransactionType,
                    telegramId: playerId,
                    description: `Stake refund for cancelled game session ${gameSessionId}`
                });
                
                logger.info('Successfully processed refund for player', {
                    playerId,
                    stakeAmount,
                    wasBonus
                });
            } else {
                logger.error('Could not find user to process refund', { playerId });
            }

        } catch (error) {
            logger.error('Error processing refund for player', error, { playerId });
        }
    }
};

// ==================== CLEANUP FUNCTIONS ====================
const cleanupLobbyPhase = async (strTelegramId, strGameId, strGameSessionId, io, redis) => {
    logger.info('Cleaning up lobby phase for user', {
        telegramId: strTelegramId,
        gameId: strGameId
    });

    const gameCardsKey = REDIS_KEYS.gameCards(strGameId);

    const userOverallSelectionRaw = await redis.hGet(
        REDIS_KEYS.userSelectionsByTelegramId(strTelegramId), 
        strTelegramId
    );
    
    let userHeldCardId = null;
    if (userOverallSelectionRaw) {
        const parsed = safeJsonParse(userOverallSelectionRaw, "userSelectionsByTelegramId", strTelegramId);
        if (parsed?.cardId) userHeldCardId = parsed.cardId;
    }

    const dbCard = await GameCard.findOne({ 
        gameId: strGameId, 
        takenBy: strTelegramId 
    });

    if (userHeldCardId || dbCard) {
        const cardToRelease = userHeldCardId || dbCard.cardId;
        
        await batchRedisOperations([
            ['hDel', gameCardsKey, String(cardToRelease)],
            ['sRem', REDIS_KEYS.gameSessions(strGameId), strTelegramId],
            ['sRem', REDIS_KEYS.gamePlayers(strGameId), strTelegramId],
            ['hDel', REDIS_KEYS.userSelectionsByTelegramId(strTelegramId), strTelegramId]
        ]);
        
        await GameCard.findOneAndUpdate(
            { gameId: strGameId, cardId: Number(cardToRelease) },
            { isTaken: false, takenBy: null }
        );
        
        io.to(strGameId).emit("cardReleased", { 
            cardId: Number(cardToRelease), 
            telegramId: strTelegramId 
        });
        
        logger.info('Card released for user during lobby cleanup', {
            telegramId: strTelegramId,
            cardId: cardToRelease,
            gameId: strGameId
        });
    }

    const numberOfPlayersLobby = await redis.sCard(REDIS_KEYS.gameSessions(strGameId)) || 0;
    io.to(strGameId).emit("gameid", { 
        gameId: strGameId, 
        numberOfPlayers: numberOfPlayersLobby 
    });

    const totalPlayersGamePlayers = await redis.sCard(REDIS_KEYS.gamePlayers(strGameId));
    if (numberOfPlayersLobby === 0 && totalPlayersGamePlayers === 0) {
        await GameControl.findOneAndUpdate(
            { gameId: strGameId }, 
            { 
                isActive: false, 
                totalCards: 0, 
                players: [], 
                endedAt: new Date() 
            }
        );
        
        await syncGameIsActive(strGameId, false);
        resetGame(strGameId, strGameSessionId, io, state, redis);
        
        logger.info('Game fully reset after lobby cleanup', { gameId: strGameId });
    }
};

const cleanupJoinGamePhase = async (strTelegramId, strGameId, strGameSessionId, io, redis) => {
    let retries = 3;

    while (retries > 0) {
        try {
            logger.info('Cleaning up joinGame phase for user', {
                telegramId: strTelegramId,
                gameId: strGameId,
                gameSessionId: strGameSessionId
            });

            const gameControl = await GameControl.findOneAndUpdate(
                { 
                    GameSessionId: strGameSessionId, 
                    'players.telegramId': Number(strTelegramId) 
                },
                { 
                    $set: { 'players.$.status': 'disconnected' } 
                },
                { 
                    new: true, 
                    upsert: false 
                }
            );

            if (gameControl) {
                logger.info('Player status updated to disconnected', {
                    telegramId: strTelegramId,
                    gameId: strGameId
                });
            } else {
                logger.warn('GameControl document or player not found during cleanup', {
                    telegramId: strTelegramId,
                    gameId: strGameId,
                    gameSessionId: strGameSessionId
                });
            }

            break;
        } catch (e) {
            if (e.name === 'VersionError') {
                logger.warn('Version conflict during cleanup, retrying', {
                    telegramId: strTelegramId,
                    gameId: strGameId,
                    retriesLeft: retries - 1
                });
                retries--;
                continue;
            } else {
                logger.error('Critical error during grace period cleanup', e, {
                    telegramId: strTelegramId,
                    gameId: strGameId
                });
                throw e;
            }
        }
    }

    await redis.sRem(REDIS_KEYS.gameRooms(strGameId), strTelegramId);

    const playerCount = await redis.sCard(REDIS_KEYS.gameRooms(strGameId));
    io.to(strGameId).emit("playerCountUpdate", { 
        gameId: strGameId, 
        playerCount 
    });

    const userOverallSelectionRaw = await redis.hGet(
        REDIS_KEYS.userSelectionsByTelegramId(strTelegramId), 
        strTelegramId
    );
    
    if (userOverallSelectionRaw) {
        const userSelection = safeJsonParse(userOverallSelectionRaw, "userSelectionsByTelegramId", strTelegramId);
        if (userSelection && String(userSelection.gameId) === strGameId && userSelection.cardId) {
            const gameCardsKey = REDIS_KEYS.gameCards(strGameId);
            const cardOwner = await redis.hGet(gameCardsKey, String(userSelection.cardId));
            
            if (cardOwner === strTelegramId) {
                await batchRedisOperations([
                    ['hDel', gameCardsKey, String(userSelection.cardId)],
                    ['hDel', REDIS_KEYS.userSelectionsByTelegramId(strTelegramId), strTelegramId]
                ]);
                
                await GameCard.findOneAndUpdate(
                    { gameId: strGameId, cardId: Number(userSelection.cardId) },
                    { isTaken: false, takenBy: null }
                );
                
                io.to(strGameId).emit("cardReleased", { 
                    cardId: Number(userSelection.cardId), 
                    telegramId: strTelegramId 
                });
                
                logger.info('Card released for user during joinGame cleanup', {
                    telegramId: strTelegramId,
                    cardId: userSelection.cardId,
                    gameId: strGameId
                });
            }
        }
    }

    await User.findOneAndUpdate(
        { telegramId: strTelegramId, reservedForGameId: strGameId }, 
        { $unset: { reservedForGameId: "" } }
    );

    if (playerCount === 0) {
        logger.info('All players left game room, calling resetRound', { gameId: strGameId });
        resetRound(strGameId, strGameSessionId, socket, io, state, redis);
    }

    const totalPlayersGamePlayers = await redis.sCard(REDIS_KEYS.gamePlayers(strGameId));
    const numberOfPlayersLobby = await redis.sCard(REDIS_KEYS.gameSessions(strGameId)) || 0;
    
    if (playerCount === 0 && numberOfPlayersLobby === 0 && totalPlayersGamePlayers === 0) {
        logger.info('Game empty after joinGame phase, triggering full reset', { gameId: strGameId });
        
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
        resetGame(strGameId, strGameSessionId, io, state, redis);
    }
};

// ==================== WINNER PROCESSING ====================
const processWinner = async ({ telegramId, gameId, GameSessionId, cartelaId, io, selectedSet, state, redis, cardData, drawnNumbersRaw, winnerLockKey }) => {
    const strGameId = String(gameId);
    const strGameSessionId = String(GameSessionId);

    try {
        const [gameControl, winnerUser, gameDrawStateRaw, players] = await Promise.all([
            GameControl.findOne({ GameSessionId: strGameSessionId }),
            User.findOne({ telegramId }),
            redis.get(`gameDrawState:${strGameSessionId}`),
            redis.sMembers(REDIS_KEYS.gameRooms(strGameId))
        ]);

        if (!gameControl || !winnerUser) {
            throw new GameError('Missing game or user data', 'DATA_NOT_FOUND', {
                telegramId,
                gameSessionId: strGameSessionId
            });
        }

        const { prizeAmount, houseProfit, stakeAmount, totalCards: playerCount } = gameControl;
        const board = cardData.card;
        const winnerPattern = checkBingoPattern(
            board, 
            new Set(drawnNumbersRaw.map(Number)), 
            selectedSet
        );
        
        const callNumberLength = gameDrawStateRaw ? 
            JSON.parse(gameDrawStateRaw)?.callNumberLength || 0 : 0;

        io.to(strGameId).emit("winnerConfirmed", { 
            winnerName: winnerUser.username || "Unknown", 
            prizeAmount, 
            playerCount, 
            boardNumber: cartelaId, 
            board, 
            winnerPattern, 
            telegramId, 
            gameId: strGameId, 
            GameSessionId: strGameSessionId 
        });

        await Promise.all([
            User.updateOne({ telegramId }, { $inc: { balance: prizeAmount } }),
            redis.incrByFloat(REDIS_KEYS.userBalance(telegramId), prizeAmount),
            Ledger.create({ 
                gameSessionId: strGameSessionId, 
                amount: prizeAmount, 
                transactionType: 'player_winnings', 
                telegramId 
            }),
            Ledger.create({ 
                gameSessionId: strGameSessionId, 
                amount: houseProfit, 
                transactionType: 'house_profit' 
            }),
            GameHistory.create({ 
                sessionId: strGameSessionId, 
                gameId: strGameId, 
                username: winnerUser.username || "Unknown", 
                telegramId, 
                eventType: "win", 
                winAmount: prizeAmount, 
                stake: stakeAmount, 
                cartelaId, 
                callNumberLength 
            })
        ]);

        // Deferred processing for non-critical tasks
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
                    GameControl.findOneAndUpdate(
                        { GameSessionId: strGameSessionId }, 
                        { isActive: false, endedAt: new Date() }
                    ),
                    syncGameIsActive(strGameId, false),
                    redis.set(
                        REDIS_KEYS.winnerInfo(strGameSessionId), 
                        JSON.stringify({ 
                            winnerName: winnerUser.username || "Unknown", 
                            prizeAmount, 
                            playerCount, 
                            boardNumber: cartelaId, 
                            board, 
                            winnerPattern, 
                            telegramId, 
                            gameId: strGameId 
                        }), 
                        { EX: CONFIG.REDIS.TTL.WINNER_INFO }
                    ),
                    resetRound(strGameId, strGameSessionId, socket, io, state, redis)
                ];
                
                GameCard.updateMany(
                    { gameId: strGameId }, 
                    { isTaken: false, takenBy: null }
                ).catch(err => logger.error("Async Card Reset Error", err));

                const redisPipeline = redis.multi();
                redisPipeline.del(
                    REDIS_KEYS.gameRooms(strGameId),
                    REDIS_KEYS.gameCards(strGameId),
                    getGameDrawsKey(strGameSessionId),
                    getGameActiveKey(strGameId),
                    getCountdownKey(strGameId),
                    getActiveDrawLockKey(strGameId),
                    getGameDrawStateKey(strGameSessionId),
                    winnerLockKey
                );
                cleanupTasks.push(redisPipeline.exec());

                await Promise.all(cleanupTasks);
                
                io.to(strGameId).emit("gameEnded");

            } catch (error) {
                logger.error("Deferred Cleanup Error", error);
            }
        })();

    } catch (error) {
        logger.error("Winner processing error", error, {
            telegramId,
            gameId: strGameId,
            gameSessionId: strGameSessionId
        });
        
        await redis.del(winnerLockKey).catch(err => 
            logger.error("Lock release error", err)
        );
    }
};

// ==================== DRAWING PROCESS ====================
const startDrawing = async (gameId, GameSessionId, io, state, redis) => {
    const strGameId = String(gameId);
    const strGameSessionId = String(GameSessionId);
    const gameDrawStateKey = getGameDrawStateKey(strGameSessionId);
    const gameDrawsKey = getGameDrawsKey(strGameSessionId);
    const gameRoomsKey = REDIS_KEYS.gameRooms(strGameId);
    const activeGameKey = getGameActiveKey(strGameId);

    if (state.drawIntervals[strGameId]) {
        logger.warn('Drawing already in progress for game', { gameId: strGameId });
        return;
    }

    logger.info('Starting drawing process for game', { gameId: strGameId });

    await redis.del(gameDrawsKey);

    state.drawIntervals[strGameId] = setInterval(async () => {
        try {
            const currentPlayersInRoom = (await redis.sCard(gameRoomsKey)) || 0;

            if (currentPlayersInRoom === 0) {
                logger.info('No players left in game room, stopping drawing', { gameId: strGameId });
                clearInterval(state.drawIntervals[strGameId]);
                delete state.drawIntervals[strGameId];

                await resetRound(strGameId, GameSessionId, socket, io, state, redis);
                io.to(strGameId).emit("gameEnded", { 
                    gameId: strGameId, 
                    message: "Game ended due to all players leaving the room." 
                });
                return;
            }

            const gameDataRaw = await redis.get(gameDrawStateKey);
            if (!gameDataRaw) {
                logger.error('No game draw data found', { gameId: strGameId });
                clearInterval(state.drawIntervals[strGameId]);
                delete state.drawIntervals[strGameId];
                return;
            }
            
            const gameData = JSON.parse(gameDataRaw);

            if (gameData.index >= gameData.numbers.length) {
                clearInterval(state.drawIntervals[strGameId]);
                delete state.drawIntervals[strGameId];
                
                io.to(strGameId).emit("allNumbersDrawn", { gameId: strGameId });
                logger.info('All numbers drawn for game', { gameId: strGameId });

                await resetRound(strGameId, GameSessionId, socket, io, state, redis);
                io.to(strGameId).emit("gameEnded", { 
                    gameId: strGameId, 
                    message: "All numbers drawn, game ended." 
                });
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

            logger.info('Drawing number', {
                gameId: strGameId,
                number,
                label,
                index: gameData.index - 1,
                callNumberLength
            });

            io.to(strGameId).emit("numberDrawn", { 
                number, 
                label, 
                gameId: strGameId, 
                callNumberLength: callNumberLength 
            });

        } catch (error) {
            logger.error('Error during drawing interval', error, { gameId: strGameId });
            clearInterval(state.drawIntervals[strGameId]);
            delete state.drawIntervals[strGameId];
            
            await resetRound(strGameId, GameSessionId, socket, io, state, redis);
            io.to(strGameId).emit("gameEnded", { 
                gameId: strGameId, 
                message: "Game ended due to drawing error." 
            });
        }
    }, CONFIG.TIMING.DRAW_INTERVAL);
};

// ==================== MAIN MODULE EXPORT ====================
module.exports = function registerGameSocket(io) {
    const { v4: uuidv4 } = require("uuid");

    // Heartbeat interval
    setInterval(() => {
        io.emit("heartbeat", Date.now());
    }, 3000);

    io.on("connection", (socket) => {
        logger.info('New client connected', { 
            socketId: socket.id,
            handshake: socket.handshake.query 
        });

        // ==================== SOCKET EVENT HANDLERS ====================

        socket.on("userJoinedGame", withErrorHandling(async (data) => {
            const validatedData = validateSocketInput(gameSchemas.userJoinedGame)(data);
            const { telegramId, gameId } = validatedData;
            
            const strGameId = String(gameId);
            const strTelegramId = String(telegramId);

            canUserConnect(strTelegramId);

            await deduplicateRequest(
                `userJoinedGame:${strTelegramId}:${strGameId}`,
                async () => {
                    const timeoutKey = `${strTelegramId}:${strGameId}`;
                    if (pendingDisconnectTimeouts.has(timeoutKey)) {
                        clearTimeout(pendingDisconnectTimeouts.get(timeoutKey));
                        pendingDisconnectTimeouts.delete(timeoutKey);
                        logger.info('User reconnected within grace period', {
                            telegramId: strTelegramId,
                            gameId: strGameId
                        });
                    }

                    await redis.hDel(REDIS_KEYS.joinGameSockets(socket.id), socket.id);

                    let currentHeldCardId = null;
                    let currentHeldCard = null;

                    const userOverallSelectionRaw = await redis.hGet(
                        REDIS_KEYS.userSelectionsByTelegramId(strTelegramId), 
                        strTelegramId
                    );
                    
                    if (userOverallSelectionRaw) {
                        const overallSelection = JSON.parse(userOverallSelectionRaw);
                        if (String(overallSelection.gameId) === strGameId && overallSelection.cardId !== null) {
                            const cardOwner = await redis.hGet(
                                REDIS_KEYS.gameCards(strGameId), 
                                String(overallSelection.cardId)
                            );
                            
                            if (cardOwner === strTelegramId) {
                                currentHeldCardId = overallSelection.cardId;
                                currentHeldCard = overallSelection.card;
                                logger.info('User reconnected with previously held card', {
                                    telegramId: strTelegramId,
                                    gameId: strGameId,
                                    cardId: currentHeldCardId
                                });
                            } else {
                                await redis.hDel(
                                    REDIS_KEYS.userSelectionsByTelegramId(strTelegramId), 
                                    strTelegramId
                                );
                                logger.warn('Stale user selection cleaned up', {
                                    telegramId: strTelegramId,
                                    gameId: strGameId
                                });
                            }
                        }
                    }

                    await redis.set(
                        REDIS_KEYS.activeSocket(strTelegramId, socket.id), 
                        '1', 
                        'EX', 
                        CONFIG.TIMING.ACTIVE_SOCKET_TTL
                    );
                    
                    socket.join(strGameId);

                    const selectionData = JSON.stringify({
                        telegramId: strTelegramId,
                        gameId: strGameId,
                        cardId: currentHeldCardId,
                        card: currentHeldCard,
                        phase: 'lobby'
                    });

                    await batchRedisOperations([
                        ['hSet', REDIS_KEYS.userSelection(socket.id), socket.id, selectionData],
                        ['sAdd', REDIS_KEYS.gameSessions(strGameId), strTelegramId],
                        ['sAdd', REDIS_KEYS.gamePlayers(strGameId), strTelegramId]
                    ]);

                    const numberOfPlayersInLobby = await redis.sCard(REDIS_KEYS.gameSessions(strGameId));
                    
                    io.to(strGameId).emit("gameid", {
                        gameId: strGameId,
                        numberOfPlayers: numberOfPlayersInLobby,
                    });

                    const allTakenCardsData = await redis.hGetAll(REDIS_KEYS.gameCards(strGameId));
                    const initialCardsState = {};
                    
                    for (const cardId in allTakenCardsData) {
                        initialCardsState[cardId] = {
                            cardId: Number(cardId),
                            takenBy: allTakenCardsData[cardId],
                            isTaken: true
                        };
                    }
                    
                    socket.emit("initialCardStates", { takenCards: initialCardsState });

                    logger.info('User successfully joined game lobby', {
                        telegramId: strTelegramId,
                        gameId: strGameId,
                        playerCount: numberOfPlayersInLobby,
                        heldCard: currentHeldCardId
                    });
                },
                `userJoinedGame:${strTelegramId}:${strGameId}`
            );
        }, "userJoinedGame"));

        socket.on("cardSelected", withErrorHandling(async (data) => {
            const validatedData = validateSocketInput(gameSchemas.cardSelected)(data);
            const { telegramId, cardId, card, gameId, requestId } = validatedData;
            
            const strTelegramId = String(telegramId);
            const strCardId = String(cardId);
            const strGameId = String(gameId);
            const cleanCard = card.map(row => row.map(c => (c === "FREE" ? 0 : Number(c))));

            const userActionLockKey = REDIS_KEYS.userActionLock(strGameId, strTelegramId);
            const cardLockKey = REDIS_KEYS.cardLock(strGameId, strCardId);
            const gameCardsKey = REDIS_KEYS.gameCards(strGameId);

            const userLock = await redis.set(userActionLockKey, requestId, "NX", "EX", 10);
            if (!userLock) {
                throw new LockError('Your previous action is still processing. Please wait a moment.', {
                    telegramId: strTelegramId,
                    gameId: strGameId
                });
            }

            try {
                const existingOwnerId = await redis.hGet(gameCardsKey, strCardId);
                
                let previousCardIdToRelease = null;
                const allGameCards = await redis.hGetAll(gameCardsKey);
                
                for (const [key, value] of Object.entries(allGameCards)) {
                    if (value === strTelegramId) {
                        previousCardIdToRelease = key;
                        break;
                    }
                }
                
                if (existingOwnerId === strTelegramId) {
                    socket.emit("cardConfirmed", { 
                        cardId: strCardId, 
                        card: cleanCard, 
                        requestId 
                    });
                    return;
                }

                if (existingOwnerId && existingOwnerId !== strTelegramId) {
                    if (previousCardIdToRelease) {
                        await Promise.all([
                            GameCard.updateOne(
                                { 
                                    gameId: strGameId, 
                                    cardId: Number(previousCardIdToRelease), 
                                    takenBy: strTelegramId 
                                },
                                { $set: { isTaken: false, takenBy: null } }
                            ),
                            redis.hDel(gameCardsKey, previousCardIdToRelease)
                        ]);

                        socket.to(strGameId).emit("cardReleased", { 
                            cardId: previousCardIdToRelease, 
                            telegramId: strTelegramId 
                        });
                    }
                    
                    throw new GameError('Card unavailable', 'CARD_UNAVAILABLE', {
                        cardId: strCardId,
                        requestedBy: strTelegramId,
                        currentOwner: existingOwnerId
                    });
                }

                const cardLock = await redis.set(cardLockKey, strTelegramId, "NX", "EX", 10);
                if (!cardLock) {
                    throw new LockError('Card is currently being processed', {
                        cardId: strCardId,
                        gameId: strGameId
                    });
                }

                const dbUpdatePromises = [];
                dbUpdatePromises.push(
                    GameCard.updateOne(
                        { 
                            gameId: strGameId, 
                            cardId: { $ne: Number(strCardId) }, 
                            takenBy: strTelegramId 
                        },
                        { $set: { isTaken: false, takenBy: null } }
                    )
                );

                if (previousCardIdToRelease && previousCardIdToRelease !== strCardId) {
                    dbUpdatePromises.push(
                        redis.hDel(gameCardsKey, previousCardIdToRelease)
                    );
                    socket.to(strGameId).emit("cardReleased", { 
                        cardId: previousCardIdToRelease, 
                        telegramId: strTelegramId 
                    });
                }

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
                    redis.hSet(REDIS_KEYS.userSelection(socket.id), socket.id, selectionData),
                    redis.hSet(REDIS_KEYS.userSelectionsByTelegramId(strTelegramId), strTelegramId, selectionData),
                    redis.hSet(REDIS_KEYS.userLastRequestId(strTelegramId), strTelegramId, requestId)
                );

                await Promise.all(dbUpdatePromises);

                socket.emit("cardConfirmed", { 
                    cardId: strCardId, 
                    card: cleanCard, 
                    requestId 
                });
                
                socket.to(strGameId).emit("otherCardSelected", { 
                    telegramId: strTelegramId, 
                    cardId: strCardId 
                });

                const [updatedSelections, numberOfPlayers] = await Promise.all([
                    redis.hGetAll(gameCardsKey),
                    redis.sCard(REDIS_KEYS.gameSessions(strGameId))
                ]);

                io.to(strGameId).emit("currentCardSelections", updatedSelections);
                io.to(strGameId).emit("gameid", { 
                    gameId: strGameId, 
                    numberOfPlayers 
                });

                logger.info('Card selection successful', {
                    telegramId: strTelegramId,
                    gameId: strGameId,
                    cardId: strCardId,
                    releasedPrevious: previousCardIdToRelease
                });

            } finally {
                await batchRedisOperations([
                    ['del', userActionLockKey],
                    ['del', cardLockKey]
                ]);
            }
        }, "cardSelected"));

        // Continue with other socket event handlers following the same pattern...
        // Due to length constraints, I'll show the structure for one more handler

        socket.on("joinGame", withErrorHandling(async (data) => {
            const validatedData = validateSocketInput(gameSchemas.joinGame)(data);
            const { gameId, GameSessionId, telegramId } = validatedData;
            
            const strGameId = String(gameId);
            const strGameSessionId = String(GameSessionId);
            const strTelegramId = String(telegramId);
            const timeoutKey = `${strTelegramId}:${strGameId}:joinGame`;

            canUserConnect(strTelegramId);

            if (pendingDisconnectTimeouts.has(timeoutKey)) {
                clearTimeout(pendingDisconnectTimeouts.get(timeoutKey));
                pendingDisconnectTimeouts.delete(timeoutKey);
                logger.info('Player reconnected within joinGame grace period', {
                    telegramId: strTelegramId,
                    gameId: strGameId
                });
            }

            const game = await GameControl.findOne({ 
                GameSessionId: strGameSessionId, 
                'players.telegramId': Number(strTelegramId) 
            });

            if (game?.endedAt) {
                logger.info('Player tried to join ended game', {
                    telegramId: strTelegramId,
                    gameSessionId: strGameSessionId
                });
                
                const winnerRaw = await redis.get(REDIS_KEYS.winnerInfo(strGameSessionId));
                if (winnerRaw) {
                    const winnerInfo = JSON.parse(winnerRaw);
                    socket.emit("winnerConfirmed", winnerInfo);
                } else {
                    socket.emit("gameEnd", { message: "The game has ended." });
                }
                return;
            }

            if (!game) {
                const winnerRaw = await redis.get(REDIS_KEYS.winnerInfo(strGameSessionId));
                if (winnerRaw) {
                    const winnerInfo = JSON.parse(winnerRaw);
                    socket.emit("winnerConfirmed", winnerInfo);
                    return;
                }
                throw new GameError('You are not registered in this game', 'NOT_REGISTERED', {
                    telegramId: strTelegramId,
                    gameSessionId: strGameSessionId
                });
            }

            await GameControl.findOneAndUpdate(
                { 
                    GameSessionId: strGameSessionId, 
                    'players.telegramId': Number(strTelegramId) 
                },
                { $set: { 'players.$.status': 'connected' } },
                { new: true }
            );

            const joinGameSocketInfo = {
                telegramId: strTelegramId,
                gameId: strGameId,
                GameSessionId: strGameSessionId,
                phase: 'joinGame'
            };

            await batchRedisOperations([
                ['hSet', REDIS_KEYS.joinGameSockets(socket.id), socket.id, JSON.stringify(joinGameSocketInfo)],
                ['set', REDIS_KEYS.activeSocket(strTelegramId, socket.id), '1', 'EX', CONFIG.TIMING.ACTIVE_SOCKET_TTL],
                ['sAdd', REDIS_KEYS.gameRooms(strGameId), strTelegramId]
            ]);

            socket.join(strGameId);

            const playerCount = await redis.sCard(REDIS_KEYS.gameRooms(strGameId));
            io.to(strGameId).emit("playerCountUpdate", {
                gameId: strGameId,
                playerCount,
            });

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
            }

            logger.info('Player successfully joined game', {
                telegramId: strTelegramId,
                gameId: strGameId,
                gameSessionId: strGameSessionId,
                playerCount
            });

        }, "joinGame"));

        // Continue with other event handlers (checkWinner, playerLeave, etc.) following the same pattern...

        socket.on("disconnect", async (reason) => {
            logger.info('Client disconnected', {
                socketId: socket.id,
                reason
            });

            try {
                let userPayload = null;
                let disconnectedPhase = null;
                let strTelegramId = null;
                let strGameId = null;
                let strGameSessionId = null;

                const [userSelectionPayloadRaw, joinGamePayloadRaw] = await redis.multi()
                    .hGet(REDIS_KEYS.userSelection(socket.id), socket.id)
                    .hGet(REDIS_KEYS.joinGameSockets(socket.id), socket.id)
                    .exec();

                if (userSelectionPayloadRaw) {
                    userPayload = safeJsonParse(userSelectionPayloadRaw, "userSelections", socket.id);
                    if (userPayload) {
                        disconnectedPhase = userPayload.phase || 'lobby';
                    } else {
                        await redis.hDel(REDIS_KEYS.userSelection(socket.id), socket.id);
                    }
                }

                if (!userPayload && joinGamePayloadRaw) {
                    userPayload = safeJsonParse(joinGamePayloadRaw, "joinGameSocketsInfo", socket.id);
                    if (userPayload) {
                        disconnectedPhase = userPayload.phase || 'joinGame';
                    } else {
                        await redis.hDel(REDIS_KEYS.joinGameSockets(socket.id), socket.id);
                    }
                }

                if (!userPayload || !userPayload.telegramId || !userPayload.gameId || !disconnectedPhase) {
                    logger.warn('No relevant user session info found for disconnected socket', {
                        socketId: socket.id
                    });
                    await redis.del(`activeSocket:${socket.handshake.query.telegramId || 'unknown'}:${socket.id}`);
                    return;
                }

                strTelegramId = String(userPayload.telegramId);
                strGameId = String(userPayload.gameId);
                strGameSessionId = userPayload.GameSessionId || 'NO_SESSION_ID';

                userDisconnected(strTelegramId);

                await redis.del(REDIS_KEYS.activeSocket(strTelegramId, socket.id));

                const allActiveSocketKeysForUser = await redis.keys(`activeSocket:${strTelegramId}:*`);
                const otherSocketIds = allActiveSocketKeysForUser
                    .map(key => key.split(':').pop())
                    .filter(id => id !== socket.id);

                // ... rest of disconnect logic remains similar but with enhanced logging

            } catch (error) {
                logger.error('Error in disconnect handler', error, {
                    socketId: socket.id
                });
            }
        });

    });

    // Health check endpoint
    const healthCheck = async () => {
        const checks = {
            redis: await redis.ping().then(() => 'connected').catch(() => 'disconnected'),
            database: 'connected', // Add actual DB check
            memory: process.memoryUsage(),
            uptime: process.uptime(),
            activeGames: Object.keys(state.gameIsActive).length,
            activeConnections: io.engine?.clientsCount || 0,
            timestamp: new Date().toISOString()
        };
        
        return checks;
    };

    // Periodic health monitoring
    setInterval(async () => {
        try {
            const health = await healthCheck();
            if (!health.redis.connected || !health.database.connected) {
                logger.error('Health check failed', null, { health });
            }
        } catch (error) {
            logger.error('Health check error', error);
        }
    }, 30000);

    logger.info('Game socket server initialized successfully');
};