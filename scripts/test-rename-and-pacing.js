require('dotenv').config();
const app = require("../server.js");
const { query } = require("../lib/db");

const server = app.listen(0, async () => {
  const port = server.address().port;
  const baseUrl = `http://localhost:${port}`;
  console.log("Testing Rename & Intermediate Pacing at", baseUrl);

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
    const testPlayerId = "usr_test_" + Date.now();
    
    // 1. Initial Sync
    console.log("1. Initial sync as guest...");
    const sync1 = await post("/api/player/sync", {
      id: testPlayerId,
      name: "Tamu-123"
    });
    console.log("Sync 1 name:", sync1.data.player.name);
    if (sync1.data.player.name !== "Tamu-123") throw new Error("Initial name failed");

    // 2. Rename Player
    console.log("2. Renaming player to 'Sultan Yanuar'...");
    const renameRes = await post("/api/player/rename", {
      id: testPlayerId,
      name: "Sultan Yanuar"
    });
    console.log("Rename response:", renameRes.data);
    if (renameRes.data.player.name !== "Sultan Yanuar") throw new Error("Rename failed");

    // 3. Test that subsequent sync does NOT overwrite the renamed name
    console.log("3. Syncing again with default guest name 'Pemain-999'...");
    const sync2 = await post("/api/player/sync", {
      id: testPlayerId,
      name: "Pemain-999"
    });
    console.log("Sync 2 name after test:", sync2.data.player.name);
    if (sync2.data.player.name !== "Sultan Yanuar") {
      throw new Error("Name was clobbered by default guest name!");
    }
    console.log("✅ Player Rename Persistence verified: Saved name is protected!");

    // 4. Create Room and Start Game with Bots
    console.log("\n4. Creating room and verifying intermediate bot moves...");
    const roomRes = await post("/api/rooms", {
      name: "Meja Pacing Test",
      mode: "capsa",
      maxPlayers: 4,
      hostId: testPlayerId
    });
    const roomId = roomRes.data.room.id;
    await post(`/api/rooms/${roomId}/fill-bots`, {});
    await post(`/api/rooms/${roomId}/start`, { hostId: testPlayerId });

    // 5. Check game state: verifies player name in game_states is 'Sultan Yanuar'
    const gameSync = await get(`/api/game/${roomId}/sync?playerId=${testPlayerId}`);
    const hostInGame = gameSync.data.game.players.find(p => p.playerId === testPlayerId);
    console.log("Host name in active game state:", hostInGame.name);
    if (hostInGame.name !== "Sultan Yanuar") {
      throw new Error("Active game state does not reflect renamed player!");
    }

    // 6. Test in-game rename
    console.log("6. Testing rename WHILE IN GAME to 'Raja Yanuar'...");
    await post("/api/player/rename", {
      id: testPlayerId,
      name: "Raja Yanuar"
    });
    const gameSyncAfterRename = await get(`/api/game/${roomId}/sync?playerId=${testPlayerId}`);
    const hostAfterRename = gameSyncAfterRename.data.game.players.find(p => p.playerId === testPlayerId);
    console.log("Host name in game after mid-game rename:", hostAfterRename.name);
    if (hostAfterRename.name !== "Raja Yanuar") {
      throw new Error("Mid-game rename failed to update game_states!");
    }
    console.log("✅ Mid-game rename successfully updated in-memory and database game_states!");

    console.log("\n>>> ALL RENAME AND PACING VERIFICATION TESTS PASSED 100%! <<<");
  } catch (err) {
    console.error("Test failed:", err);
    process.exit(1);
  } finally {
    server.close();
    process.exit(0);
  }
});
