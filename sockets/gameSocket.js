const JoinedLobbyHandler = require("./JoinedLobby"); 
const cardSelectionHandler = require("./cardSelection");
const JoinedGameHandler = require("./JoinedGame");
const GameCountHandler = require("./gameCount");
const checkWinnerHandler = require("./checkWinner");
const playerLeaveHandler = require("./playerLeave");
const disconnectHandler = require("./disconnect");



module.exports = function registerGameSocket(io, redis) {
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

const subClient = redis.duplicate();

// We create an async block to handle the connection
    (async () => {
        try {
            await subClient.connect();
            console.log("👂 Redis Subscriber connected: Listening for ADMIN_COMMANDS");
            
    await subClient.subscribe('ADMIN_COMMANDS', async (message) => {
        const action = JSON.parse(message);

        if (action.type === 'FORCE_TERMINATE') {
            // Ensure gameId is treated as a string for Socket.io room consistency
            const targetRoom = String(action.gameId);
            
            console.log(`🚫 Termination signal for Room: ${targetRoom}`);

            // 1. STOP THE DRAWING TIMER IMMEDIATELY
            if (state.drawIntervals[targetRoom]) {
                clearInterval(state.drawIntervals[targetRoom]);
                delete state.drawIntervals[targetRoom];
            }

            // 2. EMIT FIRST
            io.to(targetRoom).emit('force_game_end', {
                message: "The game session has been terminated by an administrator."
            });

            // 3. DELAY THE KICK & CLEANUP
            // This gives the frontend 1 second to receive the message and show the alert
            setTimeout(async () => {
                await fullGameCleanup(targetRoom, redis, state);
                io.in(targetRoom).socketsLeave(targetRoom);
                console.log(`🧹 Cleanup complete for ${targetRoom}`);
            }, 1000); 
        }
    });
        } catch (err) {
            console.error("❌ Redis Subscriber failed:", err);
        }
    })();




  io.on("connection", (socket) => {
    //   console.log("🟢 New client connected");
    //   console.log("Client connected with socket ID:", socket.id);
    //   console.log("Connected sockets 🟢🟢🟩:", io.sockets.sockets.size);

        // setInterval(() => {
        // const used = process.memoryUsage();
        // console.log("Heap 🚀🗑️🚀:", (used.heapUsed / 1024 / 1024).toFixed(2), "MB");
        // }, 60000);


     JoinedLobbyHandler(socket, io, redis);
     cardSelectionHandler(socket, io, redis);
     JoinedGameHandler(socket, io, redis);
     GameCountHandler(socket, io, redis, state);
     checkWinnerHandler(socket, io, redis, state);
     playerLeaveHandler(socket, io, redis);
     disconnectHandler(socket, io, redis);
  });
};





         