require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { query } = require('./lib/db');
const { initGame, processGameAction, sanitizeGameStateForPlayer } = require('./lib/engine/games');
const { getBotDecision } = require('./lib/engine/bots');

const app = express();
app.use(cors());
app.use(express.json());

// In-memory active game state cache for ultra-fast turns & SSE broadcast, synced with DB
const activeGames = new Map(); // roomId -> { state, timer }
const sseClients = new Map(); // roomId -> Set(res)

function broadcastEvent(roomId, eventType, payload) {
  // Save event to DB in background
  query(
    'INSERT INTO room_events (room_id, event_type, payload) VALUES ($1, $2, $3)',
    [roomId, eventType, JSON.stringify(payload)]
  ).catch(err => console.error('Failed to log room event:', err));

  // Push to SSE clients
  const clients = sseClients.get(roomId);
  if (clients && clients.size > 0) {
    const data = `data: ${JSON.stringify({ type: eventType, payload, timestamp: Date.now() })}\n\n`;
    for (const res of clients) {
      try {
        res.write(data);
      } catch (e) {
        clients.delete(res);
      }
    }
  }
}

// Bot auto-play loop if current turn is a bot
function checkAndRunBot(roomId) {
  const g = activeGames.get(roomId);
  if (!g || g.finished) return;

  const currentPl = g.players[g.turn];
  if (!currentPl || !currentPl.isBot) return;

  clearTimeout(g.botTimer);
  g.botTimer = setTimeout(async () => {
    try {
      const decision = getBotDecision(g, g.turn);
      if (!decision) return;

      const res = processGameAction(g, g.turn, decision.action, decision.payload);
      if (res.ok) {
        // Update DB
        await query(
          'UPDATE game_states SET version = version + 1, state = $1, updated_at = NOW() WHERE room_id = $2',
          [JSON.stringify(g), roomId]
        );

        broadcastEvent(roomId, 'GAME_UPDATE', {
          status: g.status,
          turn: g.turn,
          finished: g.finished,
          winnerText: g.winnerText,
          mode: g.mode
        });

        if (g.finished) {
          handleGameOver(roomId, g);
        } else {
          checkAndRunBot(roomId);
        }
      }
    } catch (err) {
      console.error('Error running bot turn:', err);
    }
  }, 1200);
}

async function handleGameOver(roomId, g) {
  try {
    await query("UPDATE rooms SET status = 'finished', updated_at = NOW() WHERE id = $1", [roomId]);

    if (g.winnerIdx !== null && g.winnerIdx !== undefined) {
      const winner = g.players[g.winnerIdx];
      if (winner && !winner.isBot) {
        await query(
          'UPDATE players SET coins = coins + 500, wins = wins + 1, matches = matches + 1, last_active_at = NOW() WHERE id = $1',
          [winner.playerId]
        );
      }
    }

    // Award match count to all human participants
    for (const p of g.players) {
      if (!p.isBot && (g.winnerIdx === null || p.id !== g.winnerIdx)) {
        await query(
          'UPDATE players SET coins = coins + 50, matches = matches + 1, last_active_at = NOW() WHERE id = $1',
          [p.playerId]
        );
      }
    }

    broadcastEvent(roomId, 'GAME_OVER', {
      winnerIdx: g.winnerIdx,
      winnerText: g.winnerText,
      status: g.status
    });
  } catch (err) {
    console.error('Failed to handle game over:', err);
  }
}

// ================= API ROUTES =================

// 1. Health check
app.get('/api/health', async (req, res) => {
  try {
    const dbRes = await query('SELECT NOW()');
    res.json({ ok: true, server: 'Carena 16-Bit Online', db: 'Neon Connected', time: dbRes.rows[0].now });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// 2. Player sync / login
app.post('/api/player/sync', async (req, res) => {
  try {
    const { id, name, avatar, frame, skin, tableSkin } = req.body;
    if (!id || !name) return res.status(400).json({ error: 'Missing id or name' });

    const existing = await query('SELECT * FROM players WHERE id = $1', [id]);
    if (existing.rows.length === 0) {
      const insert = await query(
        `INSERT INTO players (id, name, avatar, frame, skin, table_skin, coins, wins, matches, last_active_at)
         VALUES ($1, $2, $3, $4, $5, $6, 2500, 0, 0, NOW()) RETURNING *`,
        [id, name, avatar || '🦊', frame || 'border-amber-400', skin || 'skin-royal', tableSkin || 'table-emerald']
      );
      return res.json({ ok: true, player: insert.rows[0] });
    }

    const update = await query(
      `UPDATE players
       SET name = $2, avatar = $3, frame = $4, skin = $5, table_skin = $6, last_active_at = NOW()
       WHERE id = $1 RETURNING *`,
      [id, name, avatar || existing.rows[0].avatar, frame || existing.rows[0].frame, skin || existing.rows[0].skin, tableSkin || existing.rows[0].table_skin]
    );
    res.json({ ok: true, player: update.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 3. Leaderboard
app.get('/api/leaderboard', async (req, res) => {
  try {
    const list = await query(
      'SELECT id, name, avatar, frame, coins, wins, matches FROM players ORDER BY wins DESC, coins DESC LIMIT 20'
    );
    res.json({ ok: true, leaderboard: list.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 4. List open rooms
app.get('/api/rooms', async (req, res) => {
  try {
    const rooms = await query(`
      SELECT r.id, r.code, r.name, r.mode, r.max_players, r.is_private, r.status, r.created_at,
             p.name as host_name, p.avatar as host_avatar,
             COUNT(rp.player_id) as current_players
      FROM rooms r
      JOIN players p ON r.host_id = p.id
      LEFT JOIN room_players rp ON r.id = rp.room_id
      GROUP BY r.id, p.name, p.avatar
      ORDER BY r.created_at DESC
      LIMIT 30
    `);
    res.json({ ok: true, rooms: rooms.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 5. Create Room
app.post('/api/rooms', async (req, res) => {
  try {
    const { name, mode, maxPlayers, password, isPrivate, hostId } = req.body;
    if (!name || !mode || !hostId) return res.status(400).json({ error: 'Data ruangan tidak lengkap' });

    const code = 'KRT-' + Math.floor(1000 + Math.random() * 9000);
    const roomId = 'room_' + Date.now() + '_' + Math.floor(Math.random() * 1000);

    await query(
      `INSERT INTO rooms (id, code, name, host_id, mode, max_players, password, is_private, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'waiting')`,
      [roomId, code, name, hostId, mode, maxPlayers || 4, password || '', !!isPrivate]
    );

    // Host sits at seat 0
    await query(
      `INSERT INTO room_players (room_id, player_id, seat, is_ready, is_host, is_bot)
       VALUES ($1, $2, 0, TRUE, TRUE, FALSE)`,
      [roomId, hostId]
    );

    res.json({
      ok: true,
      room: { id: roomId, code, name, mode, max_players: maxPlayers || 4, is_private: !!isPrivate, status: 'waiting' }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 6. Get Room Details & Seated Players
app.get('/api/rooms/:id', async (req, res) => {
  try {
    const roomId = req.params.id;
    const roomRes = await query('SELECT * FROM rooms WHERE id = $1 OR code = $1', [roomId]);
    if (roomRes.rows.length === 0) return res.status(404).json({ error: 'Ruangan tidak ditemukan' });

    const room = roomRes.rows[0];
    const actualRoomId = room.id;

    const playersRes = await query(`
      SELECT rp.seat, rp.is_ready, rp.is_host, rp.is_bot, rp.bot_profile,
             COALESCE(p.id, rp.player_id) as id,
             COALESCE(p.name, rp.bot_profile->>'name') as name,
             COALESCE(p.avatar, rp.bot_profile->>'avatar') as avatar,
             COALESCE(p.frame, rp.bot_profile->>'frame') as frame,
             COALESCE(p.skin, 'skin-royal') as skin,
             COALESCE(p.table_skin, 'table-emerald') as table_skin
      FROM room_players rp
      LEFT JOIN players p ON rp.player_id = p.id
      WHERE rp.room_id = $1
      ORDER BY rp.seat ASC
    `, [actualRoomId]);

    res.json({
      ok: true,
      room: {
        id: room.id,
        code: room.code,
        name: room.name,
        host_id: room.host_id,
        mode: room.mode,
        max_players: room.max_players,
        is_private: room.is_private,
        status: room.status
      },
      players: playersRes.rows
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 7. Join Room
app.post('/api/rooms/:id/join', async (req, res) => {
  try {
    const roomIdent = req.params.id;
    const { playerId, password } = req.body;
    if (!playerId) return res.status(400).json({ error: 'Player ID required' });

    const roomRes = await query('SELECT * FROM rooms WHERE id = $1 OR code = $1', [roomIdent]);
    if (roomRes.rows.length === 0) return res.status(404).json({ error: 'Ruangan tidak ditemukan' });
    const room = roomRes.rows[0];

    if (room.is_private && room.password && room.password !== password) {
      return res.status(403).json({ error: 'Password ruangan salah!' });
    }

    if (room.status !== 'waiting') {
      return res.status(400).json({ error: 'Permainan di ruangan ini sudah dimulai atau selesai!' });
    }

    // Check if already in room
    const existing = await query('SELECT * FROM room_players WHERE room_id = $1 AND player_id = $2', [room.id, playerId]);
    if (existing.rows.length > 0) {
      return res.json({ ok: true, room, seat: existing.rows[0].seat });
    }

    // Find first empty seat
    const currentSeats = await query('SELECT seat FROM room_players WHERE room_id = $1 ORDER BY seat ASC', [room.id]);
    if (currentSeats.rows.length >= room.max_players) {
      return res.status(400).json({ error: 'Ruangan sudah penuh!' });
    }

    const taken = new Set(currentSeats.rows.map(r => r.seat));
    let targetSeat = -1;
    for (let i = 0; i < room.max_players; i++) {
      if (!taken.has(i)) {
        targetSeat = i;
        break;
      }
    }

    await query(
      `INSERT INTO room_players (room_id, player_id, seat, is_ready, is_host, is_bot)
       VALUES ($1, $2, $3, FALSE, FALSE, FALSE)`,
      [room.id, playerId, targetSeat]
    );

    const playerInfo = await query('SELECT name, avatar FROM players WHERE id = $1', [playerId]);
    const pName = playerInfo.rows[0]?.name || 'Pemain';

    broadcastEvent(room.id, 'PLAYER_JOINED', {
      playerId,
      name: pName,
      seat: targetSeat
    });

    res.json({ ok: true, room, seat: targetSeat });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 8. Leave Room
app.post('/api/rooms/:id/leave', async (req, res) => {
  try {
    const roomId = req.params.id;
    const { playerId } = req.body;
    await query('DELETE FROM room_players WHERE room_id = $1 AND player_id = $2', [roomId, playerId]);

    // Check if any players left
    const remaining = await query('SELECT * FROM room_players WHERE room_id = $1 AND is_bot = FALSE', [roomId]);
    if (remaining.rows.length === 0) {
      await query('DELETE FROM rooms WHERE id = $1', [roomId]);
      activeGames.delete(roomId);
    } else {
      // Transfer host if host left
      const room = (await query('SELECT host_id FROM rooms WHERE id = $1', [roomId])).rows[0];
      if (room && room.host_id === playerId) {
        const newHost = remaining.rows[0];
        await query('UPDATE rooms SET host_id = $1 WHERE id = $2', [newHost.player_id, roomId]);
        await query('UPDATE room_players SET is_host = TRUE WHERE room_id = $1 AND player_id = $2', [roomId, newHost.player_id]);
      }
      broadcastEvent(roomId, 'PLAYER_LEFT', { playerId });
    }

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 9. Ready toggle
app.post('/api/rooms/:id/ready', async (req, res) => {
  try {
    const roomId = req.params.id;
    const { playerId, isReady } = req.body;
    await query('UPDATE room_players SET is_ready = $1 WHERE room_id = $2 AND player_id = $3', [!!isReady, roomId, playerId]);
    broadcastEvent(roomId, 'PLAYER_READY', { playerId, isReady: !!isReady });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 10. Fill Empty Seats with Bots
const BOT_PROFILES = [
  { name: 'Raka AI', avatar: '🐯', frame: 'border-cyan-400' },
  { name: 'Nadia AI', avatar: '🐼', frame: 'border-rose-400' },
  { name: 'Bima AI', avatar: '🤖', frame: 'border-emerald-400' },
  { name: 'Sinta AI', avatar: '🐸', frame: 'border-purple-400' },
  { name: 'Dimas AI', avatar: '🤠', frame: 'border-amber-400' },
  { name: 'Tari AI', avatar: '🐙', frame: 'border-rose-400' },
  { name: 'Fajar AI', avatar: '🥷', frame: 'border-cyan-400' }
];

app.post('/api/rooms/:id/fill-bots', async (req, res) => {
  try {
    const roomId = req.params.id;
    const room = (await query('SELECT * FROM rooms WHERE id = $1', [roomId])).rows[0];
    if (!room) return res.status(404).json({ error: 'Room not found' });

    const current = (await query('SELECT seat FROM room_players WHERE room_id = $1', [roomId])).rows;
    const taken = new Set(current.map(r => r.seat));

    let botIdx = 0;
    for (let s = 0; s < room.max_players; s++) {
      if (!taken.has(s)) {
        const b = BOT_PROFILES[botIdx % BOT_PROFILES.length];
        botIdx++;
        await query(
          `INSERT INTO room_players (room_id, player_id, seat, is_ready, is_host, is_bot, bot_profile)
           VALUES ($1, $2, $3, TRUE, FALSE, TRUE, $4)`,
          [roomId, `bot_${s}_${Date.now()}`, s, JSON.stringify(b)]
        );
      }
    }

    broadcastEvent(roomId, 'ROOM_UPDATED', {});
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 11. Start Game
app.post('/api/rooms/:id/start', async (req, res) => {
  try {
    const roomId = req.params.id;
    const { hostId } = req.body;

    const room = (await query('SELECT * FROM rooms WHERE id = $1', [roomId])).rows[0];
    if (!room) return res.status(404).json({ error: 'Ruangan tidak ditemukan' });
    if (room.host_id !== hostId) return res.status(403).json({ error: 'Hanya host yang bisa memulai permainan!' });

    const playersRes = await query(`
      SELECT rp.seat, rp.is_bot, rp.bot_profile,
             COALESCE(p.id, rp.player_id) as id,
             COALESCE(p.name, rp.bot_profile->>'name') as name,
             COALESCE(p.avatar, rp.bot_profile->>'avatar') as avatar,
             COALESCE(p.frame, rp.bot_profile->>'frame') as frame
      FROM room_players rp
      LEFT JOIN players p ON rp.player_id = p.id
      WHERE rp.room_id = $1
      ORDER BY rp.seat ASC
    `, [roomId]);

    if (playersRes.rows.length < 2) {
      return res.status(400).json({ error: 'Minimal butuh 2 pemain atau tambahkan bot!' });
    }

    const gameState = initGame(room.mode, playersRes.rows);
    activeGames.set(roomId, gameState);

    await query(
      `INSERT INTO game_states (room_id, version, state, updated_at)
       VALUES ($1, 1, $2, NOW())
       ON CONFLICT (room_id) DO UPDATE SET version = game_states.version + 1, state = $2, updated_at = NOW()`,
      [roomId, JSON.stringify(gameState)]
    );

    await query("UPDATE rooms SET status = 'playing', updated_at = NOW() WHERE id = $1", [roomId]);

    broadcastEvent(roomId, 'GAME_START', { mode: room.mode });
    checkAndRunBot(roomId);

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 12. Get Game State
app.get('/api/game/:roomId', async (req, res) => {
  try {
    const roomId = req.params.roomId;
    const playerId = req.query.playerId;

    let g = activeGames.get(roomId);
    if (!g) {
      const dbG = await query('SELECT state FROM game_states WHERE room_id = $1', [roomId]);
      if (dbG.rows.length > 0) {
        g = dbG.rows[0].state;
        activeGames.set(roomId, g);
      }
    }

    if (!g) return res.status(404).json({ error: 'Game not found' });

    // Find seat index of requesting player
    let pIdx = -1;
    if (playerId) {
      pIdx = g.players.findIndex(p => p.playerId === playerId);
    }

    const sanitized = sanitizeGameStateForPlayer(g, pIdx);
    res.json({ ok: true, game: sanitized, mySeat: pIdx });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 13. Game Action
app.post('/api/game/:roomId/action', async (req, res) => {
  try {
    const roomId = req.params.roomId;
    const { playerId, action, payload } = req.body;

    let g = activeGames.get(roomId);
    if (!g) {
      const dbG = await query('SELECT state FROM game_states WHERE room_id = $1', [roomId]);
      if (dbG.rows.length > 0) {
        g = dbG.rows[0].state;
        activeGames.set(roomId, g);
      }
    }

    if (!g) return res.status(404).json({ error: 'Game not found' });

    const pIdx = g.players.findIndex(p => p.playerId === playerId);
    if (pIdx === -1) return res.status(403).json({ error: 'Player not in game' });

    const result = processGameAction(g, pIdx, action, payload);
    if (!result.ok) {
      return res.status(400).json({ error: result.error });
    }

    // Save to DB
    await query(
      'UPDATE game_states SET version = version + 1, state = $1, updated_at = NOW() WHERE room_id = $2',
      [JSON.stringify(g), roomId]
    );

    broadcastEvent(roomId, 'GAME_UPDATE', {
      action,
      status: g.status,
      turn: g.turn,
      finished: g.finished,
      winnerText: g.winnerText
    });

    if (g.finished) {
      handleGameOver(roomId, g);
    } else {
      checkAndRunBot(roomId);
    }

    res.json({ ok: true, game: sanitizeGameStateForPlayer(g, pIdx) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 14. Real-time Server-Sent Events (SSE) Stream
app.get('/api/events/:roomId', (req, res) => {
  const roomId = req.params.roomId;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  if (!sseClients.has(roomId)) {
    sseClients.set(roomId, new Set());
  }
  sseClients.get(roomId).add(res);

  res.write(`data: ${JSON.stringify({ type: 'CONNECTED', timestamp: Date.now() })}\n\n`);

  // Heartbeat every 20s to keep connection alive
  const heartbeat = setInterval(() => {
    res.write(': heartbeat\n\n');
  }, 20000);

  req.on('close', () => {
    clearInterval(heartbeat);
    const clients = sseClients.get(roomId);
    if (clients) {
      clients.delete(res);
      if (clients.size === 0) sseClients.delete(roomId);
    }
  });
});

// 15. Send Chat
app.post('/api/events/:roomId/chat', async (req, res) => {
  try {
    const roomId = req.params.roomId;
    const { playerId, message } = req.body;
    if (!message || !message.trim()) return res.status(400).json({ error: 'Message required' });

    const p = (await query('SELECT name, avatar FROM players WHERE id = $1', [playerId])).rows[0] || { name: 'Pemain', avatar: '🦊' };

    broadcastEvent(roomId, 'CHAT', {
      sender: p.name,
      avatar: p.avatar,
      message: message.trim()
    });

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 16. Send Emote
app.post('/api/events/:roomId/emote', async (req, res) => {
  try {
    const roomId = req.params.roomId;
    const { playerId, seat, emote } = req.body;

    broadcastEvent(roomId, 'EMOTE', {
      playerId,
      seat,
      emote
    });

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Serve frontend static assets
app.use(express.static(path.join(__dirname, 'public')));
app.use((req, res, next) => {
  if (req.path.startsWith('/api')) return next();
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start server if run directly
if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`Carena 16-Bit server running on port ${PORT}`);
  });
}

module.exports = app;
