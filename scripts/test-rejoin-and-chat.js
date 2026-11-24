require('dotenv').config();
const app = require("../server.js");
const { pool } = require("../lib/db");

const server = app.listen(0, async () => {
  const port = server.address().port;
  const baseUrl = `http://localhost:${port}`;
  console.log("Testing Player Rejoin & Chat Isolation at", baseUrl);

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
    const p1Id = "usr_orig_" + Date.now();
    const pName = "Yanuar Boss";

    // 1. Register / Sync Player 1
    console.log("1. Setting up Player 1 as:", pName);
    await post("/api/player/sync", { id: p1Id, name: pName });

    // 2. Create room and start game
    console.log("2. Creating room and starting game with 3 bots...");
    const cr = await post("/api/rooms", {
      name: "Meja Rejoin Yanuar",
      mode: "capsa",
      maxPlayers: 4,
      hostId: p1Id
    });
    const roomId = cr.data.room.id;
    const fill = await post(`/api/rooms/${roomId}/fill-bots`, { hostId: p1Id });
    if (!fill.data.ok) throw new Error(fill.data.error || "Failed to fill bot seats");
    const startRes = await post(`/api/rooms/${roomId}/start`, { hostId: p1Id });
    if (!startRes.data.ok) throw new Error("Failed to start game");

    console.log("Game started successfully. Room status is 'playing'.");

    // Send a chat message in this room
    console.log("3. Sending chat message in room...");
    await post(`/api/events/${roomId}/chat`, {
      playerId: p1Id,
      message: "Halo semua, saya Yanuar!"
    });

    const roomSync = await get(`/api/rooms/${roomId}/sync?since=0`);
    const chatEvents = roomSync.data.events.filter(e => e.event_type === 'CHAT');
    console.log("Chat events in Room 1:", chatEvents.length, "message:", chatEvents[0]?.payload?.message);
    if (chatEvents.length === 0) throw new Error("Chat was not recorded!");

    // A display name can be shared by different users and cannot recover a seat.
    const p1RejoinId = "usr_newtab_" + Date.now();
    const sameNameResponse = await post(`/api/rooms/${roomId}/join`, {
      playerId: p1RejoinId,
      playerName: pName
    });
    if (sameNameResponse.data.ok) throw new Error("A new ID with the same name replaced the host");

    console.log("\n4. Simulating reconnect with the original player ID...");
    const rejoinRes = await post(`/api/rooms/${roomId}/join`, {
      playerId: p1Id,
      playerName: pName
    });

    console.log("Rejoin response:", rejoinRes.status, rejoinRes.data);
    if (!rejoinRes.data.ok) {
      throw new Error(`Rejoin failed with error: ${rejoinRes.data.error}`);
    }
    if (rejoinRes.data.seat !== 0) {
      throw new Error(`Expected seat 0, got ${rejoinRes.data.seat}`);
    }
    if (!rejoinRes.data.reconnected) {
      throw new Error("Expected reconnected: true");
    }
    console.log("✅ Rejoin with the original ID into playing game succeeded!");

    const gameCheck = await get(`/api/game/${roomId}?playerId=${p1Id}`);
    console.log("Game check mySeat:", gameCheck.data.mySeat);
    if (gameCheck.data.mySeat !== 0) throw new Error("The original player's seat was lost");
    const myPlayer = gameCheck.data.game.players[0];
    console.log("Player name in game:", myPlayer.name, "cards in hand:", myPlayer.hand.length);
    if (!myPlayer.hand || myPlayer.hand.length === 0) {
      throw new Error("Private hand cards missing on reconnect!");
    }
    console.log("✅ Reconnected player successfully retrieved their private hand cards!");

    // 5. Test Stranger with DIFFERENT NAME trying to enter playing room
    console.log("\n5. Testing stranger with name 'Orang Lain' trying to enter playing game...");
    const strangerRes = await post(`/api/rooms/${roomId}/join`, {
      playerId: "usr_stranger_1",
      playerName: "Orang Lain"
    });
    console.log("Stranger response:", strangerRes.status, strangerRes.data);
    if (strangerRes.data.ok) {
      throw new Error("Stranger should NOT have been allowed to join a playing game!");
    }
    console.log("✅ Stranger correctly blocked from joining playing game!");

    // 6. Test Chat Isolation in a New Room
    console.log("\n6. Creating Room 2 to test chat history isolation...");
    const cr2 = await post("/api/rooms", {
      name: "Meja Kedua Baru",
      mode: "capsa",
      maxPlayers: 4,
      hostId: p1Id
    });
    const room2Id = cr2.data.room.id;
    const room2Sync = await get(`/api/rooms/${room2Id}/sync?since=0`);
    const room2Chats = room2Sync.data.events.filter(e => e.event_type === 'CHAT');
    console.log("Chat events in brand new Room 2:", room2Chats.length);
    if (room2Chats.length !== 0) {
      throw new Error("New room has old chat events!");
    }
    console.log("✅ New room has completely clean, 0-event chat history!");

    console.log("\n>>> REJOIN & CHAT ISOLATION TESTS PASSED <<<");
  } catch (err) {
    console.error("Test failed:", err);
    process.exitCode = 1;
  } finally {
    server.close();
    await pool.end();
  }
});
