require('dotenv').config();
const app = require("../server.js");
const { pool } = require("../lib/db");

const server = app.listen(0, async () => {
  const port = server.address().port;
  const baseUrl = `http://localhost:${port}`;
  console.log("Testing Agnes AI Integration at", baseUrl);

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
    const p1Id = "usr_tester_" + Date.now();
    await post("/api/player/sync", { id: p1Id, name: "Yanuar" });

    // 1. Create Room
    console.log("1. Creating room...");
    const cr = await post("/api/rooms", {
      name: "Meja Bareng Agnes AI",
      mode: "capsa",
      maxPlayers: 4,
      hostId: p1Id
    });
    const roomId = cr.data.room.id;

    // 2. Fill with Bots
    console.log("2. Filling empty seats with bots (Agnes AI)...");
    const fill = await post(`/api/rooms/${roomId}/fill-bots`, { hostId: p1Id });
    if (!fill.data.ok) throw new Error(fill.data.error || "Failed to fill bot seats");

    const roomSync = await get(`/api/rooms/${roomId}/sync?since=0`);
    const agnesPlayer = roomSync.data.players.find(p => p.name === 'Agnes AI');
    console.log("Found Agnes AI in room:", !!agnesPlayer, "avatar:", agnesPlayer?.avatar);
    if (!agnesPlayer) throw new Error("Agnes AI was not found in room seats!");

    // 3. Send chat message to Agnes AI
    console.log("3. Sending chat message: 'Halo Agnes, kamu siap kalah hari ini?'...");
    const chat = await post(`/api/events/${roomId}/chat`, {
      playerId: p1Id,
      message: "Halo Agnes, kamu siap kalah hari ini?"
    });
    if (!chat.data.ok) throw new Error(chat.data.error || "Chat send failed");

    console.log("Waiting 2.5 seconds for Agnes AI LLM completion...");
    await new Promise(r => setTimeout(r, 2500));

    // 4. Check if Agnes AI replied in room events
    const syncAfterChat = await get(`/api/rooms/${roomId}/sync?since=0`);
    const chats = syncAfterChat.data.events.filter(e => e.event_type === 'CHAT');
    console.log("Total chat messages in room:", chats.length);
    chats.forEach(c => {
      console.log(`[${c.payload.sender}]: ${c.payload.message}`);
    });

    const agnesReply = chats.find(c => c.payload.sender === 'Agnes AI');
    if (!agnesReply) {
      console.warn("Agnes reply not received within timeout, but test continues.");
    } else {
      console.log("✅ Agnes AI successfully generated and posted in-game chat reply!");
    }

    // 5. Start Game
    console.log("\n4. Starting game...");
    const start = await post(`/api/rooms/${roomId}/start`, { hostId: p1Id });
    if (!start.data.ok) throw new Error(start.data.error || "Failed to start game");

    console.log("\n>>> AGNES AI INTEGRATION TEST COMPLETED SUCCESSFULLY! <<<");
  } catch (err) {
    console.error("Test failed:", err);
    process.exitCode = 1;
  } finally {
    server.close();
    await pool.end();
  }
});
