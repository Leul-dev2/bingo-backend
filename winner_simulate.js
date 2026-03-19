const { io } = require("socket.io-client");
const { performance } = require("perf_hooks");

// --- CONFIGURATION ---
const SERVER_URL         = "http://localhost:3000"; // Change if your server runs on a different port
const CONCURRENT_PLAYERS = 50;                      // Number of players to blast simultaneously
const GAME_ID            = "10";                    // Matches your seed script
const GAME_SESSION_ID    = "TEST_SESSION_10";       // Replace with an active GameSessionId from your DB
const START_TELEGRAM     = 900000;                  // Matches your seed script
const WINNING_NUMBERS    = [25];                    // Since your dummy cards are all 25s

async function createPlayerClient(playerIndex) {
  return new Promise((resolve, reject) => {
    // Match the exact logic from your seed script
    const telegramId = START_TELEGRAM + playerIndex;
    const cartelaId  = (playerIndex * 3) + 1; // Grabbing the first card seeded for this player
    
    const socket = io(SERVER_URL, {
      reconnection: false,
      transports: ["websocket"],
    });

    socket.on("connect", () => {
      // 1. Authenticate / Join Lobby
      socket.emit("joinGame", { 
        gameId: GAME_ID, 
        telegramId: telegramId, 
        GameSessionId: GAME_SESSION_ID 
      });

      // Give the backend a moment to register the socket.data.telegramId
      setTimeout(() => {
        resolve({ socket, telegramId, cartelaId });
      }, 500);
    });

    socket.on("connect_error", (err) => reject(`Connection failed for ${telegramId}: ${err.message}`));
  });
}

async function runConcurrencyTest() {
  console.log(`🚀 Starting Concurrency Test with ${CONCURRENT_PLAYERS} seeded players...`);
  
  const players = [];
  for (let i = 0; i < CONCURRENT_PLAYERS; i++) {
    try {
      const client = await createPlayerClient(i);
      players.push(client);
    } catch (err) {
      console.error(err);
    }
  }
  
  console.log(`✅ ${players.length} players connected. Ready to blast.`);
  console.log(`💥 Firing "checkWinner" simultaneously in 2 seconds...`);

  await new Promise(resolve => setTimeout(resolve, 2000));

  let winnersCount      = 0;
  let errorsCount       = 0;
  let failedClaimsCount = 0;
  
  // 2. Prepare the promises for the simultaneous blast
  const claimPromises = players.map(({ socket, telegramId, cartelaId }) => {
    return new Promise((resolve) => {
      const startTime = performance.now();

      // Successful Win
      socket.once("winnerConfirmed", (data) => {
        const endTime = performance.now();
        winnersCount++;
        resolve({ telegramId, status: "WON 🏆", latency: (endTime - startTime).toFixed(2), reason: "ProcessWinner complete" });
      });

      // Blocked by Redis Lock (Expected for all but 1)
      socket.once("winnerError", (data) => {
        const endTime = performance.now();
        errorsCount++;
        resolve({ telegramId, status: "BLOCKED 🔒", latency: (endTime - startTime).toFixed(2), reason: data.message });
      });

      // Validation Failure (e.g., pattern wrong, no numbers drawn)
      socket.once("bingoClaimFailed", (data) => {
        const endTime = performance.now();
        failedClaimsCount++;
        resolve({ telegramId, status: "FAILED ❌", latency: (endTime - startTime).toFixed(2), reason: data.message });
      });

      // Emit the exact payload your checkWinner.js expects
      socket.emit("checkWinner", {
        gameId: GAME_ID,
        GameSessionId: GAME_SESSION_ID,
        cartelaId: String(cartelaId),
        selectedNumbers: WINNING_NUMBERS,
      });
    });
  });

  // 3. Blast the server all at exactly the same time
  const results = await Promise.all(claimPromises);

  // 4. Cleanup & Analyze
  players.forEach(p => p.socket.disconnect());

  console.log("\n📊 --- TEST RESULTS ---");
  console.table(results.map(r => ({
    Player: r.telegramId, 
    Result: r.status, 
    Latency_ms: r.latency, 
    Message: r.reason
  })));

  console.log("\n📝 --- SUMMARY ---");
  console.log(`Total Winners Allowed: ${winnersCount} (Should be EXACTLY 1)`);
  console.log(`Blocked by Lock:       ${errorsCount} (Should be EXACTLY ${CONCURRENT_PLAYERS - 1})`);
  console.log(`Validation Fails:      ${failedClaimsCount} (Should be 0 if game state is correct)`);

  if (winnersCount > 1) {
    console.error("\n🚨 ATOMICITY FAILURE: Multiple players bypassed the lock!");
  } else if (winnersCount === 1) {
    console.log("\n✅ ATOMICITY SUCCESS: Redis NX lock flawlessly blocked the thundering herd.");
  } else {
    console.log("\n⚠️ NO WINNERS: Everyone failed validation. See below.");
  }
  
  process.exit(0);
}

runConcurrencyTest();