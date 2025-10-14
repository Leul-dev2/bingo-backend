const express = require('express');
const router = express.Router();
const User = require("../models/user");
const GameControl = require('../models/GameControl');
const GameCard = require("../models/GameCard");
const redis = require("../utils/redisClient");
const { v4: uuidv4 } = require('uuid');
const mongoose = require('mongoose');

// ==================== CONFIGURATION ====================
const CONFIG = {
    DEFAULT: {
        GAME_TOTAL_CARDS: 1,
        STAKE_AMOUNT: 10,
        CREATED_BY: 'System',
        IS_ACTIVE: false
    },
    REDIS: {
        TTL: {
            GAME_STATUS: 60,
            LOCK: 15,
            NEGATIVE_CACHE: 30
        }
    }
};

// ==================== ERROR HANDLING ====================
class GameAPIError extends Error {
    constructor(message, code, statusCode = 500, context = {}) {
        super(message);
        this.name = 'GameAPIError';
        this.code = code;
        this.statusCode = statusCode;
        this.context = context;
        this.timestamp = new Date().toISOString();
    }
}

class ValidationError extends GameAPIError {
    constructor(message, context = {}) {
        super(message, 'VALIDATION_ERROR', 400, context);
    }
}

class ResourceNotFoundError extends GameAPIError {
    constructor(message, context = {}) {
        super(message, 'RESOURCE_NOT_FOUND', 404, context);
    }
}

class ConflictError extends GameAPIError {
    constructor(message, context = {}) {
        super(message, 'CONFLICT_ERROR', 409, context);
    }
}

class LockError extends GameAPIError {
    constructor(message, context = {}) {
        super(message, 'LOCK_ERROR', 429, context);
    }
}

class InsufficientBalanceError extends GameAPIError {
    constructor(message, context = {}) {
        super(message, 'INSUFFICIENT_BALANCE', 400, context);
    }
}

// ==================== UTILITY FUNCTIONS ====================
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

// Simple validation functions
const validateGameId = (gameId) => {
    if (!gameId) {
        throw new ValidationError('Game ID is required', { field: 'gameId' });
    }
    
    const numGameId = Number(gameId);
    if (isNaN(numGameId) || numGameId <= 0) {
        throw new ValidationError('Game ID must be a positive number', { field: 'gameId', value: gameId });
    }
    
    return String(gameId);
};

const validateTelegramId = (telegramId) => {
    if (!telegramId) {
        throw new ValidationError('Telegram ID is required', { field: 'telegramId' });
    }
    
    const numTelegramId = Number(telegramId);
    if (isNaN(numTelegramId) || numTelegramId <= 0) {
        throw new ValidationError('Telegram ID must be a positive number', { field: 'telegramId', value: telegramId });
    }
    
    return String(telegramId);
};

const validateCardId = (cardId) => {
    if (!cardId) {
        throw new ValidationError('Card ID is required', { field: 'cardId' });
    }
    
    const numCardId = Number(cardId);
    if (isNaN(numCardId) || numCardId <= 0) {
        throw new ValidationError('Card ID must be a positive number', { field: 'cardId', value: cardId });
    }
    
    return String(cardId);
};

const validateStartGameInput = (body) => {
    const { gameId, telegramId, cardId } = body;
    
    if (!gameId || !telegramId || !cardId) {
        throw new ValidationError('Missing required fields: gameId, telegramId, cardId');
    }
    
    return {
        gameId: validateGameId(gameId),
        telegramId: validateTelegramId(telegramId),
        cardId: validateCardId(cardId)
    };
};

const validateGameStatusInput = (params) => {
    const { gameId } = params;
    
    if (!gameId) {
        throw new ValidationError('Game ID is required', { field: 'gameId' });
    }
    
    return {
        gameId: validateGameId(gameId)
    };
};

const acquireDistributedLock = async (key, ttl = CONFIG.REDIS.TTL.LOCK) => {
    const lockValue = `locked:${Date.now()}`;
    const acquired = await redis.set(key, lockValue, 'EX', ttl, 'NX');
    return acquired ? lockValue : false;
};

const releaseDistributedLock = async (key, lockValue) => {
    try {
        const currentLockValue = await redis.get(key);
        if (currentLockValue === lockValue) {
            await redis.del(key);
            return true;
        }
        return false;
    } catch (error) {
        logger.error('Error releasing distributed lock', error, { key });
        return false;
    }
};

const withErrorHandling = (handler) => {
    return async (req, res, next) => {
        try {
            await handler(req, res, next);
        } catch (error) {
            logger.error('API route error', error, {
                path: req.path,
                method: req.method,
                params: req.params,
                body: req.body
            });

            if (error instanceof GameAPIError) {
                return res.status(error.statusCode).json({
                    success: false,
                    error: error.message,
                    code: error.code,
                    ...(process.env.NODE_ENV === 'development' && { context: error.context })
                });
            }

            // MongoDB duplicate key error
            if (error.code === 11000) {
                return res.status(409).json({
                    success: false,
                    error: 'Resource already exists',
                    code: 'DUPLICATE_RESOURCE'
                });
            }

            // MongoDB validation error
            if (error.name === 'ValidationError') {
                return res.status(400).json({
                    success: false,
                    error: 'Validation failed',
                    code: 'MONGO_VALIDATION_ERROR',
                    details: Object.values(error.errors).map(err => ({
                        field: err.path,
                        message: err.message
                    }))
                });
            }

            res.status(500).json({
                success: false,
                error: 'Internal server error',
                code: 'INTERNAL_SERVER_ERROR'
            });
        }
    };
};

const withTransaction = async (session, operation) => {
    try {
        await session.withTransaction(operation);
    } catch (error) {
        await session.abortTransaction();
        throw error;
    }
};

// ==================== REDIS KEY MANAGEMENT ====================
const REDIS_KEYS = {
    gameLock: (gameId) => `startLock:${gameId}`,
    gameActive: (gameId) => `gameIsActive:${gameId}`,
    gameRooms: (gameId) => `gameRooms:${gameId}`,
    userBalance: (telegramId) => `userBalance:${telegramId}`,
    userBonusBalance: (telegramId) => `userBonusBalance:${telegramId}`
};

// ==================== ROUTE HANDLERS ====================

/**
 * @route POST /api/games/start
 * @description Start or join a game session with proper transaction handling
 */
router.post("/start", withErrorHandling(async (req, res) => {
    // Validate input
    const validatedData = validateStartGameInput(req.body);
    const { gameId, telegramId, cardId } = validatedData;
    
    const strGameId = gameId;
    const strTelegramId = telegramId;
    const strCardId = cardId;
    
    const lockKey = REDIS_KEYS.gameLock(strGameId);
    const session = await mongoose.startSession();
    let lockValue = null;
    let responseSent = false;

    try {
        // Acquire distributed lock
        lockValue = await acquireDistributedLock(lockKey);
        if (!lockValue) {
            throw new LockError(
                "A game start request is already being processed. Please wait a moment.",
                { gameId: strGameId }
            );
        }

        logger.info('Starting game session', {
            gameId: strGameId,
            telegramId: strTelegramId,
            cardId: strCardId
        });

        await withTransaction(session, async () => {
            // 1. Check for ACTIVE game
            const activeGame = await GameControl.findOne({
                gameId: strGameId,
                isActive: true,
                endedAt: null
            }).session(session).lean();

            if (activeGame) {
                throw new ConflictError(
                    "A game is already running. Please join it.",
                    { 
                        gameId: strGameId,
                        GameSessionId: activeGame.GameSessionId 
                    }
                );
            }

            // 2. Check for INACTIVE lobby or create one
            let lobbyDoc = await GameControl.findOne({
                gameId: strGameId,
                isActive: false,
                endedAt: null
            }).session(session);

            const stakeAmount = Number(strGameId) > 0 ? Number(strGameId) : CONFIG.DEFAULT.STAKE_AMOUNT;

            if (!lobbyDoc) {
                const newGameSessionId = uuidv4();
                lobbyDoc = new GameControl({
                    GameSessionId: newGameSessionId,
                    gameId: strGameId,
                    isActive: CONFIG.DEFAULT.IS_ACTIVE,
                    createdBy: CONFIG.DEFAULT.CREATED_BY,
                    stakeAmount: stakeAmount,
                    totalCards: CONFIG.DEFAULT.GAME_TOTAL_CARDS,
                    prizeAmount: 0,
                    players: [],
                    houseProfit: 0,
                    createdAt: new Date(),
                    endedAt: null,
                });
                await lobbyDoc.save({ session });
                
                logger.info('Created new game lobby', {
                    gameId: strGameId,
                    GameSessionId: newGameSessionId,
                    stakeAmount
                });
            }

            const currentSessionId = lobbyDoc.GameSessionId;

            // 3. Check if user is already in the lobby
            const isMemberDB = lobbyDoc.players.some(player => 
                String(player.telegramId) === strTelegramId
            );

            if (isMemberDB) {
                responseSent = true;
                return res.status(200).json({
                    success: true,
                    gameId: strGameId,
                    telegramId: strTelegramId,
                    message: "Already in lobby",
                    GameSessionId: currentSessionId,
                    stakeAmount: lobbyDoc.stakeAmount
                });
            }

            // 4. Validate the card
            const card = await GameCard.findOne({ 
                gameId: strGameId, 
                cardId: Number(strCardId)
            }).session(session);
            
            if (!card) {
                throw new ValidationError(
                    "Card not found",
                    { 
                        gameId: strGameId,
                        cardId: strCardId
                    }
                );
            }

            if (!card.isTaken || String(card.takenBy) !== strTelegramId) {
                throw new ValidationError(
                    "Invalid card selection. Please try another card.",
                    { 
                        gameId: strGameId,
                        cardId: strCardId,
                        telegramId: strTelegramId,
                        cardOwner: card.takenBy,
                        isTaken: card.isTaken
                    }
                );
            }

            // 5. Reserve user's stake with atomic check
            const numericTelegramId = Number(strTelegramId);
            const user = await User.findOneAndUpdate(
                {
                    telegramId: numericTelegramId,
                    $or: [
                        { reservedForGameId: { $exists: false } },
                        { reservedForGameId: null },
                        { reservedForGameId: "" }
                    ],
                    $or: [
                        { bonus_balance: { $gte: lobbyDoc.stakeAmount } },
                        { balance: { $gte: lobbyDoc.stakeAmount } }
                    ]
                },
                { 
                    $set: { 
                        reservedForGameId: currentSessionId,
                        lastGameJoinAttempt: new Date()
                    } 
                },
                { 
                    new: true, 
                    session,
                    runValidators: true,
                    lean: true
                }
            );

            if (!user) {
                // Check why the user update failed
                const userCheck = await User.findOne({ 
                    telegramId: numericTelegramId 
                }).session(session).lean();

                if (!userCheck) {
                    throw new ResourceNotFoundError('User not found', { telegramId: strTelegramId });
                }

                if (userCheck.reservedForGameId) {
                    throw new ConflictError(
                        "Already in another game",
                        {
                            telegramId: strTelegramId,
                            reservedForGameId: userCheck.reservedForGameId
                        }
                    );
                }

                // Check balance
                const hasSufficientBalance = userCheck.bonus_balance >= lobbyDoc.stakeAmount || 
                                           userCheck.balance >= lobbyDoc.stakeAmount;
                
                if (!hasSufficientBalance) {
                    throw new InsufficientBalanceError(
                        "Insufficient balance",
                        {
                            telegramId: strTelegramId,
                            requiredAmount: lobbyDoc.stakeAmount,
                            currentBalance: userCheck.balance,
                            currentBonusBalance: userCheck.bonus_balance
                        }
                    );
                }

                throw new ConflictError("Unable to join game at this time");
            }

            // 6. Add user to GameControl
            await GameControl.updateOne(
                { GameSessionId: currentSessionId },
                { 
                    $addToSet: { 
                        players: { 
                            telegramId: numericTelegramId,
                            status: 'connected',
                            joinedAt: new Date()
                        } 
                    } 
                },
                { session }
            );

            // 7. Update Redis cache
            await Promise.all([
                redis.sAdd(REDIS_KEYS.gameRooms(strGameId), strTelegramId),
                redis.del(REDIS_KEYS.gameActive(strGameId)),
                redis.set(REDIS_KEYS.userBalance(strTelegramId), user.balance.toString(), "EX", 60),
                redis.set(REDIS_KEYS.userBonusBalance(strTelegramId), user.bonus_balance.toString(), "EX", 60)
            ]);

            responseSent = true;
            
            const response = {
                success: true,
                gameId: strGameId,
                telegramId: strTelegramId,
                message: "Joined game successfully. Your stake has been reserved.",
                GameSessionId: currentSessionId,
                stakeAmount: lobbyDoc.stakeAmount,
                userBalance: user.balance,
                userBonusBalance: user.bonus_balance
            };

            logger.info('User successfully joined game', {
                gameId: strGameId,
                telegramId: strTelegramId,
                GameSessionId: currentSessionId,
                stakeAmount: lobbyDoc.stakeAmount
            });

            return res.status(200).json(response);
        });

    } catch (error) {
        if (!responseSent) {
            logger.error('Game start error', error, {
                gameId: strGameId,
                telegramId: strTelegramId,
                cardId: strCardId
            });
            throw error;
        }
    } finally {
        // Cleanup
        if (lockValue) {
            await releaseDistributedLock(lockKey, lockValue)
                .catch(err => logger.error('Lock release error', err, { lockKey }));
        }
        
        await session.endSession().catch(err => 
            logger.error('Session end error', err)
        );
    }
}));

/**
 * @route GET /api/games/:gameId/status
 * @description Get current game status with caching
 */
router.get('/:gameId/status', withErrorHandling(async (req, res) => {
    const validatedParams = validateGameStatusInput(req.params);
    const { gameId } = validatedParams;
    
    const strGameId = gameId;

    try {
        // Try Redis cache first
        const cachedStatus = await redis.get(REDIS_KEYS.gameActive(strGameId));
        if (cachedStatus !== null) {
            return res.json({
                success: true,
                isActive: cachedStatus === 'true',
                exists: true,
                source: 'cache',
                gameId: strGameId,
                timestamp: new Date().toISOString()
            });
        }

        // Database lookup with proper error handling
        const game = await GameControl.findOne({ gameId: strGameId })
            .sort({ createdAt: -1 })
            .select('isActive players stakeAmount createdAt endedAt GameSessionId')
            .lean()
            .maxTimeMS(5000);

        if (!game) {
            // Cache negative result to prevent DB queries
            await redis.set(
                REDIS_KEYS.gameActive(strGameId), 
                'false', 
                'EX', 
                CONFIG.REDIS.TTL.NEGATIVE_CACHE
            );
            
            throw new ResourceNotFoundError(
                'Game not found',
                { gameId: strGameId }
            );
        }

        // Cache the result
        await redis.set(
            REDIS_KEYS.gameActive(strGameId), 
            game.isActive ? 'true' : 'false', 
            'EX', 
            CONFIG.REDIS.TTL.GAME_STATUS
        );

        const response = {
            success: true,
            isActive: game.isActive,
            exists: true,
            playersCount: game.players?.length || 0,
            stakeAmount: game.stakeAmount,
            createdAt: game.createdAt,
            GameSessionId: game.GameSessionId,
            source: 'database',
            gameId: strGameId,
            timestamp: new Date().toISOString()
        };

        // Add endedAt if the game has ended
        if (game.endedAt) {
            response.endedAt = game.endedAt;
        }

        return res.json(response);

    } catch (error) {
        if (error instanceof ResourceNotFoundError) {
            throw error;
        }
        
        logger.error('Game status check error', error, { gameId: strGameId });
        throw new GameAPIError(
            'Server error during status check',
            'STATUS_CHECK_ERROR',
            500,
            { gameId: strGameId }
        );
    }
}));

/**
 * @route GET /api/games/health
 * @description Health check endpoint
 */
router.get('/health', async (req, res) => {
    try {
        const healthChecks = {
            redis: await redis.ping().then(() => 'connected').catch(() => 'disconnected'),
            database: 'unknown',
            timestamp: new Date().toISOString(),
            uptime: process.uptime(),
            memory: process.memoryUsage()
        };

        // Check database connection
        try {
            await GameControl.findOne().limit(1).lean();
            healthChecks.database = 'connected';
        } catch (error) {
            healthChecks.database = 'disconnected';
            healthChecks.databaseError = error.message;
        }

        const isHealthy = healthChecks.redis === 'connected' && healthChecks.database === 'connected';
        
        res.status(isHealthy ? 200 : 503).json({
            success: isHealthy,
            status: isHealthy ? 'healthy' : 'unhealthy',
            ...healthChecks
        });

    } catch (error) {
        logger.error('Health check error', error);
        res.status(503).json({
            success: false,
            status: 'unhealthy',
            error: 'Health check failed',
            timestamp: new Date().toISOString()
        });
    }
});

/**
 * @route GET /api/games/:gameId/details
 * @description Get detailed game information
 */
router.get('/:gameId/details', withErrorHandling(async (req, res) => {
    const validatedParams = validateGameStatusInput(req.params);
    const { gameId } = validatedParams;
    
    const strGameId = gameId;

    const game = await GameControl.findOne({ gameId: strGameId })
        .sort({ createdAt: -1 })
        .select('isActive players stakeAmount prizeAmount houseProfit createdAt endedAt GameSessionId totalCards')
        .lean()
        .maxTimeMS(5000);

    if (!game) {
        throw new ResourceNotFoundError(
            'Game not found',
            { gameId: strGameId }
        );
    }

    const response = {
        success: true,
        gameId: strGameId,
        GameSessionId: game.GameSessionId,
        isActive: game.isActive,
        stakeAmount: game.stakeAmount,
        prizeAmount: game.prizeAmount,
        houseProfit: game.houseProfit,
        totalCards: game.totalCards,
        playersCount: game.players?.length || 0,
        players: game.players?.map(player => ({
            telegramId: player.telegramId,
            status: player.status,
            joinedAt: player.joinedAt
        })) || [],
        createdAt: game.createdAt,
        endedAt: game.endedAt,
        timestamp: new Date().toISOString()
    };

    res.json(response);
}));

module.exports = router;