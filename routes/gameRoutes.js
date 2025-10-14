const express = require('express');
const router = express.Router();
const User = require("../models/user");
const GameControl = require('../models/GameControl');
const GameCard = require("../models/GameCard");
const redis = require("../utils/redisClient");
const { v4: uuidv4 } = require('uuid');
const mongoose = require('mongoose');
const Joi = require('joi');
const rateLimit = require('express-rate-limit');

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
            NEGATIVE_CACHE: 30,
            LOCK: 15,
            USER_BALANCE: 60
        }
    },
    VALIDATION: {
        MIN_GAME_ID: 1,
        MAX_GAME_ID: 1000
    }
};

// ==================== RATE LIMITING ====================
const startGameLimiter = rateLimit({
    windowMs: 1 * 60 * 1000, // 1 minute
    max: 5, // 5 requests per minute
    message: {
        success: false,
        error: "Too many game start attempts. Please try again later."
    },
    standardHeaders: true,
    legacyHeaders: false,
});

const statusCheckLimiter = rateLimit({
    windowMs: 30 * 1000, // 30 seconds
    max: 30, // 30 requests per 30 seconds
    message: {
        success: false,
        error: "Too many status check requests. Please slow down."
    },
    standardHeaders: true,
    legacyHeaders: false,
});

// ==================== VALIDATION SCHEMAS ====================
const validationSchemas = {
    startGame: Joi.object({
        gameId: Joi.alternatives()
            .try(
                Joi.string().pattern(/^\d+$/).required(),
                Joi.number().integer().min(CONFIG.VALIDATION.MIN_GAME_ID).max(CONFIG.VALIDATION.MAX_GAME_ID).required()
            ),
        telegramId: Joi.alternatives()
            .try(
                Joi.string().pattern(/^\d+$/).required(),
                Joi.number().integer().positive().required()
            ),
        cardId: Joi.alternatives()
            .try(
                Joi.string().pattern(/^\d+$/).required(),
                Joi.number().integer().positive().required()
            )
    }),
    
    gameStatus: Joi.object({
        gameId: Joi.alternatives()
            .try(
                Joi.string().pattern(/^\d+$/).required(),
                Joi.number().integer().min(CONFIG.VALIDATION.MIN_GAME_ID).max(CONFIG.VALIDATION.MAX_GAME_ID).required()
            )
    }),
    
    userStatus: Joi.object({
        telegramId: Joi.alternatives()
            .try(
                Joi.string().pattern(/^\d+$/).required(),
                Joi.number().integer().positive().required()
            )
    })
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

const validateInput = (schema, data) => {
    const { error, value } = schema.validate(data, {
        abortEarly: false,
        stripUnknown: true
    });
    
    if (error) {
        const details = error.details.map(detail => ({
            field: detail.path.join('.'),
            message: detail.message
        }));
        
        throw new ValidationError('Invalid input provided', { details });
    }
    
    return value;
};

const safeMongoId = (id) => {
    if (mongoose.Types.ObjectId.isValid(id)) {
        return new mongoose.Types.ObjectId(id);
    }
    return id;
};

const acquireDistributedLock = async (key, ttl = CONFIG.REDIS.TTL.LOCK) => {
    const lockValue = `locked:${Date.now()}`;
    const acquired = await redis.set(key, lockValue, 'EX', ttl, 'NX');
    return acquired ? lockValue : false;
};

const releaseDistributedLock = async (key, lockValue) => {
    const currentLockValue = await redis.get(key);
    if (currentLockValue === lockValue) {
        await redis.del(key);
        return true;
    }
    return false;
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
 * @route POST /api/game/start
 * @description Start or join a game session
 */
router.post("/start", startGameLimiter, withErrorHandling(async (req, res) => {
    const validatedData = validateInput(validationSchemas.startGame, req.body);
    const { gameId, telegramId, cardId } = validatedData;
    
    const strGameId = String(gameId);
    const strTelegramId = String(telegramId);
    const strCardId = String(cardId);
    
    const lockKey = REDIS_KEYS.gameLock(strGameId);
    const session = await mongoose.startSession();
    let lockValue = null;

    try {
        // Acquire distributed lock
        lockValue = await acquireDistributedLock(lockKey);
        if (!lockValue) {
            throw new LockError(
                "A game start request is already being processed. Please wait a moment.",
                { gameId: strGameId }
            );
        }

        let result;
        
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
                lobbyDoc = new GameControl({
                    GameSessionId: uuidv4(),
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
                    GameSessionId: lobbyDoc.GameSessionId,
                    stakeAmount
                });
            }

            const currentSessionId = lobbyDoc.GameSessionId;

            // 3. Check if user is already in the lobby
            const isMemberDB = lobbyDoc.players.some(player => 
                String(player.telegramId) === strTelegramId
            );

            if (isMemberDB) {
                result = {
                    success: true,
                    gameId: strGameId,
                    telegramId: strTelegramId,
                    message: "Already in lobby",
                    GameSessionId: currentSessionId,
                    stakeAmount: lobbyDoc.stakeAmount
                };
                return;
            }

            // 4. Validate the card
            const card = await GameCard.findOne({ 
                gameId: strGameId, 
                cardId: Number(strCardId)
            }).session(session);
            
            if (!card || !card.isTaken || String(card.takenBy) !== strTelegramId) {
                throw new ValidationError(
                    "Invalid card selection. Please try another card.",
                    { 
                        gameId: strGameId,
                        cardId: strCardId,
                        telegramId: strTelegramId
                    }
                );
            }

            // 5. Reserve user's stake with proper atomic check
            const user = await User.findOneAndUpdate(
                {
                    telegramId: Number(strTelegramId),
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
                throw new ConflictError(
                    "Insufficient balance or already in another game.",
                    {
                        telegramId: strTelegramId,
                        requiredAmount: lobbyDoc.stakeAmount,
                        currentBalance: user?.balance,
                        currentBonusBalance: user?.bonus_balance
                    }
                );
            }

            // 6. Add user to GameControl
            await GameControl.updateOne(
                { GameSessionId: currentSessionId },
                { 
                    $addToSet: { 
                        players: { 
                            telegramId: Number(strTelegramId),
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
                redis.del(REDIS_KEYS.gameActive(strGameId)), // Invalidate cache
                redis.set(REDIS_KEYS.userBalance(strTelegramId), user.balance.toString(), "EX", CONFIG.REDIS.TTL.USER_BALANCE),
                redis.set(REDIS_KEYS.userBonusBalance(strTelegramId), user.bonus_balance.toString(), "EX", CONFIG.REDIS.TTL.USER_BALANCE)
            ]);

            result = {
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
        });

        return res.status(200).json(result);

    } catch (error) {
        logger.error('Game start error', error, {
            gameId: strGameId,
            telegramId: strTelegramId,
            cardId: strCardId
        });
        
        throw error; // Let withErrorHandling handle the response

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
 * @route GET /api/game/:gameId/status
 * @description Get current game status
 */
router.get('/:gameId/status', statusCheckLimiter, withErrorHandling(async (req, res) => {
    const validatedParams = validateInput(validationSchemas.gameStatus, req.params);
    const { gameId } = validatedParams;
    
    const strGameId = String(gameId);

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
            .maxTimeMS(5000); // 5 second timeout

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
 * @route GET /api/game/user/:telegramId/status
 * @description Get user's current game status and balance information
 */
router.get('/user/:telegramId/status', statusCheckLimiter, withErrorHandling(async (req, res) => {
    const validatedParams = validateInput(validationSchemas.userStatus, req.params);
    const { telegramId } = validatedParams;
    
    const strTelegramId = String(telegramId);

    try {
        // Try Redis cache first for user data
        const [cachedBalance, cachedBonusBalance] = await Promise.all([
            redis.get(REDIS_KEYS.userBalance(strTelegramId)),
            redis.get(REDIS_KEYS.userBonusBalance(strTelegramId))
        ]);

        let user, currentGame;
        
        // Only query database if we don't have cached data
        if (cachedBalance === null || cachedBonusBalance === null) {
            user = await User.findOne({ telegramId: Number(strTelegramId) })
                .select('reservedForGameId balance bonus_balance username')
                .lean()
                .maxTimeMS(5000);

            if (!user) {
                throw new ResourceNotFoundError(
                    'User not found',
                    { telegramId: strTelegramId }
                );
            }

            // Update cache
            await Promise.all([
                redis.set(REDIS_KEYS.userBalance(strTelegramId), user.balance.toString(), "EX", CONFIG.REDIS.TTL.USER_BALANCE),
                redis.set(REDIS_KEYS.userBonusBalance(strTelegramId), user.bonus_balance.toString(), "EX", CONFIG.REDIS.TTL.USER_BALANCE)
            ]);
        } else {
            user = {
                telegramId: Number(strTelegramId),
                balance: parseFloat(cachedBalance),
                bonus_balance: parseFloat(cachedBonusBalance),
                reservedForGameId: null // We don't cache this as it changes frequently
            };
            
            // Still need to get reservedForGameId from DB
            const userReservation = await User.findOne({ telegramId: Number(strTelegramId) })
                .select('reservedForGameId username')
                .lean();
                
            if (userReservation) {
                user.reservedForGameId = userReservation.reservedForGameId;
                user.username = userReservation.username;
            }
        }

        // Get current game information if user has a reservation
        if (user.reservedForGameId) {
            currentGame = await GameControl.findOne({
                GameSessionId: user.reservedForGameId
            }).select('gameId isActive stakeAmount players createdAt').lean();
        }

        const response = {
            success: true,
            user: {
                telegramId: strTelegramId,
                username: user.username,
                balance: user.balance,
                bonus_balance: user.bonus_balance,
                reservedForGameId: user.reservedForGameId,
                source: cachedBalance !== null ? 'cache' : 'database'
            },
            currentGame: currentGame ? {
                gameId: currentGame.gameId,
                isActive: currentGame.isActive,
                stakeAmount: currentGame.stakeAmount,
                playerCount: currentGame.players?.length || 0,
                createdAt: currentGame.createdAt,
                GameSessionId: user.reservedForGameId
            } : null,
            timestamp: new Date().toISOString()
        };

        return res.json(response);

    } catch (error) {
        if (error instanceof ResourceNotFoundError) {
            throw error;
        }
        
        logger.error('User status check error', error, { telegramId: strTelegramId });
        throw new GameAPIError(
            'Internal server error while fetching user status',
            'USER_STATUS_ERROR',
            500,
            { telegramId: strTelegramId }
        );
    }
}));

/**
 * @route GET /api/game/health
 * @description Health check endpoint
 */
router.get('/health', async (req, res) => {
    try {
        const healthChecks = {
            redis: await redis.ping().then(() => 'connected').catch(() => 'disconnected'),
            database: 'unknown', // We'll check with a simple query
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
 * @route GET /api/game/:gameId/details
 * @description Get detailed game information
 */
router.get('/:gameId/details', statusCheckLimiter, withErrorHandling(async (req, res) => {
    const validatedParams = validateInput(validationSchemas.gameStatus, req.params);
    const { gameId } = validatedParams;
    
    const strGameId = String(gameId);

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