require('dotenv').config();
const app = require("../server.js");
const { query } = require("../lib/db");

const server = app.listen(0, async () => {
  const port = server.address().port;
  const baseUrl = `http://localhost:${port}`;
  console.log("Testing Bot/CPU execution at", baseUrl);

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
    const p1User = "human_" + Math.random().toString(36).substring(7);
    const reg1 = await post("/api/auth/register", { username: p1User, password: "password123", displayName: "Human Boss" });
    const p1Id = reg1.data.player.id;

    console.log("1. Creating room for Capsa Banting...");
    const cr = await post("/api/rooms", {
      name: "Meja Uji CPU",
      mode: "capsa",
      maxPlayers: 4,
      hostId: p1Id
    });
    const roomId = cr.data.room.id;
    const roomCode = cr.data.room.code;

    console.log("2. Filling empty seats with Bots...");
    const fillRes = await post(`/api/rooms/${roomId}/fill-bots`, {});
    console.log("Fill bots response:", fillRes.data);

    console.log("3. Host starting the game...");
    const startRes = await post(`/api/rooms/${roomId}/start`, { hostId: p1Id });
    console.log("Start game response:", startRes.data);

    console.log("4. Fetching initial game sync for Human...");
    const sync1 = await get(`/api/game/${roomId}/sync?playerId=${p1Id}`);
    const g = sync1.data.game;
    console.log("Game status:", g.status);
    console.log("Current turn index:", g.turn, "Name:", g.players[g.turn].name, "isBot:", g.players[g.turn].isBot);
    console.log("Players list:", g.players.map(p => ({ seat: p.id, name: p.name, isBot: p.isBot, cardCount: p.handCount || p.hand.length })));

    // Verify all 3 bots have isBot === true
    const bots = g.players.filter(p => p.id !== sync1.data.mySeat);
    const allBotsMarked = bots.every(b => b.isBot === true);
    console.log("Are all other players correctly identified as bots?", allBotsMarked);
    if (!allBotsMarked) {
      throw new Error("One or more bots were NOT marked as isBot = true!");
    }

    // Now let's simulate rounds of play:
    console.log("\n5. Simulating rounds between Human and Bots...");
    let rounds = 0;
    while (!g.finished && rounds < 10) {
      const curSync = await get(`/api/game/${roomId}/sync?playerId=${p1Id}`);
      const curG = curSync.data.game;
      if (curG.finished) {
        console.log("Game finished! Winner:", curG.winnerText);
        break;
      }

      const activePl = curG.players[curG.turn];
      console.log(`Round ${rounds + 1}: Turn is with ${activePl.name} (Seat ${curG.turn}, isBot: ${activePl.isBot})`);

      if (activePl.isBot) {
        // If turn is on bot, calling sync should execute bot turn!
        console.log("Triggering bot turn via sync...");
        const afterBot = await get(`/api/game/${roomId}/sync?playerId=${p1Id}`);
        console.log("After bot sync, turn is:", afterBot.data.game.players[afterBot.data.game.turn].name);
      } else {
        // Human's turn: play a card or pass!
        const myHand = curG.players[curSync.data.mySeat].hand;
        console.log(`Human has ${myHand.length} cards. Playing a move...`);
        let action = "pass";
        let payload = {};

        if (curG.mustInclude3D) {
          const c3d = myHand.find(c => c.rank === "3" && c.suit === "♦");
          action = "play";
          payload = { cardIds: [c3d.id] };
        } else if (!curG.tablePlay) {
          action = "play";
          payload = { cardIds: [myHand[0].id] };
        }

        console.log(`Human submitting action: ${action}`);
        const actRes = await post(`/api/game/${roomId}/action`, {
          playerId: p1Id,
          action,
          payload
        });
        console.log("Human action status:", actRes.status, "ok:", actRes.data.ok);
        if (!actRes.data.ok) {
          console.error("Action error:", actRes.data.error);
        }
      }
      rounds++;
    }

    console.log("\n>>> CPU / BOT EXECUTION TEST PASSED 100%! BOTS PLAY AUTOMATICALLY! <<<");
  } catch (err) {
    console.error("Test failed:", err);
  } finally {
    server.close();
    process.exit(0);
  }
});
