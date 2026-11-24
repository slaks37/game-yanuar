require('dotenv').config();
const app = require("../server.js");
const { pool, query } = require("../lib/db");

const server = app.listen(0, async () => {
  const port = server.address().port;
  const baseUrl = `http://localhost:${port}`;
  console.log("Test server running at", baseUrl);

  async function post(url, data) {
    const res = await fetch(`${baseUrl}${url}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data)
    });
    return { status: res.status, data: await res.json() };
  }

  async function get(url) {
    const res = await fetch(`${baseUrl}${url}`);
    return { status: res.status, data: await res.json() };
  }

  try {
    console.log("=== TEST 1: TURN SYNCHRONIZATION BETWEEN PLAYER 1 AND PLAYER 2 ===");
    const p1User = "p1_" + Math.random().toString(36).substring(7);
    const reg1 = await post("/api/auth/register", { username: p1User, password: "password123", name: "Pemain Satu" });
    const p1Id = reg1.data.player.id;

    const p2User = "p2_" + Math.random().toString(36).substring(7);
    const reg2 = await post("/api/auth/register", { username: p2User, password: "password123", name: "Pemain Dua" });
    const p2Id = reg2.data.player.id;

    const crRes = await post("/api/rooms", {
      name: "Meja Sinkron PvP",
      mode: "capsa",
      maxPlayers: 2,
      hostId: p1Id
    });
    const roomId = crRes.data.room.id;
    const roomCode = crRes.data.room.code;

    const joined = await post(`/api/rooms/${roomCode}/join`, { playerId: p2Id });
    if (!joined.data.ok) throw new Error(joined.data.error || "Failed to join room");
    const started = await post(`/api/rooms/${roomId}/start`, { hostId: p1Id });
    if (!started.data.ok) throw new Error(started.data.error || "Failed to start game");

    // Sync P1
    const p1Sync = await get(`/api/game/${roomId}/sync?playerId=${p1Id}`);
    // Sync P2
    const p2Sync = await get(`/api/game/${roomId}/sync?playerId=${p2Id}`);

    console.log("P1 sees mySeat:", p1Sync.data.mySeat, "Turn:", p1Sync.data.game.turn);
    console.log("P2 sees mySeat:", p2Sync.data.mySeat, "Turn:", p2Sync.data.game.turn);

    const activeSeat = p1Sync.data.game.turn;
    const activePlayerId = activeSeat === 0 ? p1Id : p2Id;
    const otherSeat = 1 - activeSeat;
    console.log(`Active player is Seat ${activeSeat} (Player ID: ${activePlayerId})`);

    // The active player plays their turn!
    const activePlayerHand = (activeSeat === 0 ? p1Sync : p2Sync).data.game.players[activeSeat].hand;
    // Find valid card to play (3D if needed)
    const card3D = activePlayerHand.find(c => c.rank === "3" && c.suit === "♦") || activePlayerHand[0];

    console.log(`Seat ${activeSeat} plays card: ${card3D.rank}${card3D.suit}`);
    const playRes = await post(`/api/game/${roomId}/action`, {
      playerId: activePlayerId,
      action: "play",
      payload: { cardIds: [card3D.id] },
      version: p1Sync.data.version
    });
    if (!playRes.data.ok) throw new Error(playRes.data.error || "Opening move failed");
    console.log("Play result status:", playRes.status, "ok:", playRes.data.ok);

    // Now verify turn passed to the other player!
    const p1SyncAfter = await get(`/api/game/${roomId}/sync?playerId=${p1Id}`);
    const p2SyncAfter = await get(`/api/game/${roomId}/sync?playerId=${p2Id}`);

    console.log("After move, P1 sees turn:", p1SyncAfter.data.game.turn);
    console.log("After move, P2 sees turn:", p2SyncAfter.data.game.turn);
    if (p1SyncAfter.data.game.turn === otherSeat && p2SyncAfter.data.game.turn === otherSeat) {
      console.log("[PASS] Turn synchronized perfectly across both players!");
    } else {
      throw new Error(`Turn desync detected! Expected ${otherSeat}, got P1=${p1SyncAfter.data.game.turn}, P2=${p2SyncAfter.data.game.turn}`);
    }

    console.log("\n=== TEST 2: 60-SECOND TURN TIMER & AUTOMATIC TIMEOUT PASS ===");
    console.log("Simulating 65 seconds timeout by updating turnStartedAt in DB...");
    const timeoutTime = Date.now() - 65000;
    const dbG = await query("SELECT state FROM game_states WHERE room_id = $1", [roomId]);
    const stateObj = dbG.rows[0].state;
    stateObj.turnStartedAt = timeoutTime;
    await query("UPDATE game_states SET state = $1 WHERE room_id = $2", [JSON.stringify(stateObj), roomId]);

    const turnBeforeTimeout = stateObj.turn;
    console.log("Turn before timeout check:", turnBeforeTimeout);

    // Call sync to trigger timeout auto-pass
    const syncTimeoutRes = await get(`/api/game/${roomId}/sync?playerId=${p1Id}`);
    const turnAfterTimeout = syncTimeoutRes.data.game.turn;
    console.log("Turn after timeout check:", turnAfterTimeout);
    console.log("Game status after timeout:", syncTimeoutRes.data.game.status);

    if (turnAfterTimeout !== turnBeforeTimeout) {
      console.log("[PASS] 60-second AFK timeout automatically passed/moved and advanced the turn!");
    } else {
      throw new Error(`Timed-out turn did not advance: ${syncTimeoutRes.data.game.status}`);
    }

    console.log("\n=== TEST 3: 7-MINUTE INACTIVITY AUTO CLEANUP ===");
    const staleRoomCode = "KRT-" + Math.floor(1000 + Math.random() * 9000);
    const staleRoomId = "room_stale_" + Date.now();
    await query(`
      INSERT INTO rooms (id, code, name, host_id, mode, max_players, status, updated_at)
      VALUES ($1, $2, 'Ruang Terlantar 10 Menit', $3, 'capsa', 4, 'waiting', NOW() - INTERVAL '10 minutes')
    `, [staleRoomId, staleRoomCode, p1Id]);

    console.log("Stale room inserted with updated_at = 10 minutes ago:", staleRoomId);
    // Call GET /api/rooms which triggers the 7-minute sweep
    const roomsList = await get("/api/rooms");
    const checkStale = roomsList.data.rooms.find(r => r.id === staleRoomId);
    console.log("Is stale room present in rooms list?", !!checkStale);
    if (!checkStale) {
      console.log("[PASS] Stale room inactive > 7 minutes was automatically deleted!");
    } else {
      throw new Error("Stale room was not deleted!");
    }

    console.log("\n=== TEST 4: MANUAL ROOM DELETION ===");
    const delRes = await post(`/api/rooms/${roomId}/delete`, { playerId: p1Id });
    if (!delRes.data.ok) throw new Error(delRes.data.error || "Failed to delete room");
    console.log("Host deleted room status:", delRes.status, delRes.data);
    const roomsAfterDel = await get("/api/rooms");
    const foundDel = roomsAfterDel.data.rooms.find(r => r.id === roomId);
    console.log("Deleted room exists in lobby?", !!foundDel);
    if (!foundDel) {
      console.log("[PASS] Host manual room deletion verified!");
    } else {
      throw new Error("Deleted room still exists in lobby!");
    }

    console.log("\n==========================================");
    console.log("ALL VERIFICATION TESTS COMPLETED WITH 100% PASS RATE!");
    console.log("==========================================");
  } catch (err) {
    console.error("Test error:", err);
    process.exitCode = 1;
  } finally {
    server.close();
    await pool.end();
  }
});
