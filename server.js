require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const { query } = require('./lib/db');
const { initGame, processGameAction, sanitizeGameStateForPlayer } = require('./lib/engine/games');
const { getBotDecision } = require('./lib/engine/bots');

const app = express();
app.use(cors());
app.use(express.json());

// Password hashing helper
function hashPassword(password) {
  const salt = 'carena_pixel_salt_2026';
  return crypto.scryptSync(password, salt, 32).toString('hex');
}

// In-memory SSE clients per instance (for instant pushes when on same container)
const sseClients = new Map(); // roomId -> Set(res)

async function recordRoomEvent(roomId, eventType, payload) {
  try {
    const res = await query(
      'INSERT INTO room_events (room_id, event_type, payload) VALUES ($1, $2, $3) RETURNING id, created_at',
      [roomId, eventType, JSON.stringify(payload)]
    );
    const eventId = res.rows[0]?.id;

    // Push to local SSE clients if any
    const clients = sseClients.get(roomId);
    if (clients && clients.size > 0) {
      const data = `data: ${JSON.stringify({ id: eventId, type: eventType, payload, timestamp: Date.now() })}\n\n`;
      for (const client of clients) {
        try {
          client.write(data);
        } catch (e) {
          clients.delete(client);
        }
      }
    }
    return eventId;
  } catch (err) {
    console.error('Failed to log room event:', err);
    return null;
  }
}

// Execute 1 bot turn step on authoritative state in Neon DB
// Paced execution allows human players to visually see every CPU move step-by-step
async function runBotTurnsIfNeeded(roomId, g, force = false) {
  if (!g || g.finished) return g;

  const currentPl = g.players[g.turn];
  if (!currentPl) return g;
  const isBot = !!(currentPl.isBot || (currentPl.playerId && String(currentPl.playerId).startsWith('bot_')));
  if (!isBot) return g;

  // Realistic pacing: ensure at least 700ms has elapsed so players can observe the previous move
  const elapsedMs = Date.now() - (g.turnStartedAt || 0);
  if (!force && elapsedMs < 700) {
    return g;
  }

  currentPl.isBot = true;

  const decision = getBotDecision(g, g.turn);
  if (!decision) {
    console.warn(`[Bot Warning] No decision for bot ${currentPl.name} in mode ${g.mode}. Advancing turn.`);
    g.turn = (g.turn + 1) % g.players.length;
    g.turnStartedAt = Date.now();
  } else {
    const res = processGameAction(g, g.turn, decision.action, decision.payload);
    if (!res.ok) {
      console.error(`[Bot Error] Action failed for bot ${currentPl.name}: ${res.error}. Forcing fallback.`);
      if (g.mode === 'capsa') {
        if (g.mustInclude3D) {
          const c3d = currentPl.hand.find(c => c.rank === '3' && c.suit === '♦');
          if (c3d) processGameAction(g, g.turn, 'play', { cardIds: [c3d.id] });
          else g.turn = (g.turn + 1) % g.players.length;
        } else {
          processGameAction(g, g.turn, 'pass', {});
        }
      } else {
        g.turn = (g.turn + 1) % g.players.length;
      }
      g.turnStartedAt = Date.now();
    } else {
      // In Empatsatu (41), bot needs to draw AND discard in the same turn
      if (g.mode === 'empatsatu' && g.phase === 'discard') {
        const discardDec = getBotDecision(g, g.turn);
        if (discardDec) {
          processGameAction(g, g.turn, discardDec.action, discardDec.payload);
        }
      }
    }
  }

  // Save updated state to DB and increment version
  await query(
    'UPDATE game_states SET version = version + 1, state = $1, updated_at = NOW() WHERE room_id = $2',
    [JSON.stringify(g), roomId]
  );

  await recordRoomEvent(roomId, 'GAME_UPDATE', {
    status: g.status,
    turn: g.turn,
    finished: g.finished,
    winnerText: g.winnerText,
    mode: g.mode
  });

  if (g.finished) {
    await handleGameOver(roomId, g);
  }

  return g;
}

// Check and enforce 60s max turn timer (Auto Pass / Move if player AFK)
async function checkAndApplyTurnTimeout(roomId, g) {
  if (!g || g.finished || !g.turnStartedAt) return g;
  const elapsed = Date.now() - g.turnStartedAt;
  const limit = (g.turnTimeLimitSec || 60) * 1000;

  if (elapsed >= limit) {
    const timedOutPlayer = g.players[g.turn];
    if (!timedOutPlayer) return g;

    // Use AI decision fallback to execute optimal pass/play for timed out player
    const decision = getBotDecision(g, g.turn);
    if (decision) {
      const res = processGameAction(g, g.turn, decision.action, decision.payload);
      if (res.ok) {
        g.turnStartedAt = Date.now();
        g.status = `⏱️ Waktu habis (1 mnt)! ${timedOutPlayer.name} otomatis Pass/Jalan. ${g.status || ''}`;

        await query(
          'UPDATE game_states SET version = version + 1, state = $1, updated_at = NOW() WHERE room_id = $2',
          [JSON.stringify(g), roomId]
        );

        await recordRoomEvent(roomId, 'GAME_UPDATE', {
          action: 'TIMEOUT_AUTO',
          status: g.status,
          turn: g.turn,
          finished: g.finished,
          winnerText: g.winnerText
        });

        if (g.finished) {
          await handleGameOver(roomId, g);
        } else {
          await runBotTurnsIfNeeded(roomId, g);
        }
      }
    }
  }
  return g;
}

async function handleGameOver(roomId, g) {
  try {
    await query("UPDATE rooms SET status = 'finished', updated_at = NOW() WHERE id = $1", [roomId]);

    if (g.winnerIdx !== null && g.winnerIdx !== undefined) {
      const winner = g.players[g.winnerIdx];
      if (winner && !winner.isBot) {
        await query(
          `UPDATE players
           SET coins = coins + 500,
               highscore = GREATEST(COALESCE(highscore, 0), coins + 500),
               wins = wins + 1,
               matches = matches + 1,
               last_active_at = NOW()
           WHERE id = $1`,
          [winner.playerId]
        );
      }
    }

    // Award match count to all human participants
    for (const p of g.players) {
      if (!p.isBot && (g.winnerIdx === null || p.id !== g.winnerIdx)) {
        await query(
          `UPDATE players
           SET coins = coins + 50,
               highscore = GREATEST(COALESCE(highscore, 0), coins + 50),
               matches = matches + 1,
               last_active_at = NOW()
           WHERE id = $1`,
          [p.playerId]
        );
      }
    }

    await recordRoomEvent(roomId, 'GAME_OVER', {
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

// 2. Auth: Register
app.post('/api/auth/register', async (req, res) => {
  try {
    const { username, password, name, avatar, frame } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'Username dan password wajib diisi!' });
    }

    const cleanUsername = username.trim().toLowerCase();
    if (cleanUsername.length < 3 || cleanUsername.length > 20) {
      return res.status(400).json({ error: 'Username harus 3–20 karakter!' });
    }
    if (!/^[a-z0-9_]+$/.test(cleanUsername)) {
      return res.status(400).json({ error: 'Username hanya boleh huruf, angka, dan underscore!' });
    }
    if (password.length < 4) {
      return res.status(400).json({ error: 'Password minimal 4 karakter!' });
    }

    const check = await query('SELECT id FROM players WHERE LOWER(username) = $1', [cleanUsername]);
    if (check.rows.length > 0) {
      return res.status(409).json({ error: 'Username ini sudah terdaftar! Silakan login.' });
    }

    const newId = 'usr_' + Date.now() + '_' + Math.floor(100 + Math.random() * 900);
    const passHash = hashPassword(password);
    const displayName = (name && name.trim()) || username.trim();

    const insert = await query(
      `INSERT INTO players (id, username, password_hash, name, avatar, frame, skin, table_skin, coins, highscore, wins, matches, last_active_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'skin-royal', 'table-emerald', 2500, 2500, 0, 0, NOW())
       RETURNING id, username, name, avatar, frame, skin, table_skin, coins, highscore, wins, matches, created_at`,
      [newId, cleanUsername, passHash, displayName, avatar || '🦊', frame || 'border-amber-400']
    );

    res.json({ ok: true, player: insert.rows[0] });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ error: err.message });
  }
});

// 2b. Auth: Login
app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'Username dan password wajib diisi!' });
    }

    const cleanUsername = username.trim().toLowerCase();
    const result = await query(
      `SELECT id, username, password_hash, name, avatar, frame, skin, table_skin, coins, highscore, wins, matches, created_at
       FROM players WHERE LOWER(username) = $1`,
      [cleanUsername]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Username tidak ditemukan!' });
    }

    const player = result.rows[0];
    const passHash = hashPassword(password);
    if (player.password_hash !== passHash) {
      return res.status(401).json({ error: 'Password salah!' });
    }

    await query('UPDATE players SET last_active_at = NOW() WHERE id = $1', [player.id]);

    delete player.password_hash;
    res.json({ ok: true, player });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: err.message });
  }
});

// 2c. Player Rename (Ganti Nama)
app.post('/api/player/rename', async (req, res) => {
  try {
    const { id, name } = req.body;
    if (!id || !name || !name.trim()) {
      return res.status(400).json({ error: 'Nama tidak boleh kosong!' });
    }

    const cleanName = name.trim().slice(0, 24);
    // Upsert into players table guaranteed
    const update = await query(
      `INSERT INTO players (id, name, avatar, frame, skin, table_skin, coins, highscore, wins, matches, last_active_at)
       VALUES ($1, $2, '🦊', 'border-amber-400', 'skin-royal', 'table-emerald', 2500, 2500, 0, 0, NOW())
       ON CONFLICT (id) DO UPDATE SET name = $2, last_active_at = NOW()
       RETURNING id, username, name, avatar, frame, skin, table_skin, coins, highscore, wins, matches`,
      [id, cleanName]
    );

    const updatedPlayer = update.rows[0];

    // Update any active game state where this player is seated
    const activeGames = await query(
      `SELECT gs.room_id, gs.state, gs.version
       FROM game_states gs
       JOIN room_players rp ON gs.room_id = rp.room_id
       WHERE rp.player_id = $1`,
      [id]
    );

    for (const gRow of activeGames.rows) {
      const gState = gRow.state;
      let stateChanged = false;
      if (gState && gState.players) {
        for (const pl of gState.players) {
          if (pl.playerId === id) {
            pl.name = cleanName;
            stateChanged = true;
          }
        }
      }
      if (stateChanged) {
        await query(
          'UPDATE game_states SET version = version + 1, state = $1, updated_at = NOW() WHERE room_id = $2',
          [JSON.stringify(gState), gRow.room_id]
        );
      }
    }

    // Broadcast to any room player is in
    const roomsSeated = await query('SELECT DISTINCT room_id, seat FROM room_players WHERE player_id = $1', [id]);
    for (const r of roomsSeated.rows) {
      await recordRoomEvent(r.room_id, 'PLAYER_NAME_CHANGED', { playerId: id, name: cleanName, seat: r.seat });
    }

    res.json({ ok: true, player: updatedPlayer });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 2d. Player sync (profile, skins, highscore update)
app.post('/api/player/sync', async (req, res) => {
  try {
    const { id, name, avatar, frame, skin, tableSkin } = req.body;
    if (!id) return res.status(400).json({ error: 'Missing id' });

    const existing = await query('SELECT * FROM players WHERE id = $1', [id]);
    if (existing.rows.length === 0) {
      const insert = await query(
        `INSERT INTO players (id, name, avatar, frame, skin, table_skin, coins, highscore, wins, matches, last_active_at)
         VALUES ($1, $2, $3, $4, $5, $6, 2500, 2500, 0, 0, NOW())
         RETURNING id, username, name, avatar, frame, skin, table_skin, coins, highscore, wins, matches`,
        [id, name || 'Pemain', avatar || '🦊', frame || 'border-amber-400', skin || 'skin-royal', tableSkin || 'table-emerald']
      );
      return res.json({ ok: true, player: insert.rows[0] });
    }

    // Preserve saved name in database so it is never overwritten by default guest name
    const authoritativeName = existing.rows[0].name || name;

    const update = await query(
      `UPDATE players
       SET name = $2,
           avatar = $3,
           frame = $4,
           skin = $5,
           table_skin = $6,
           highscore = GREATEST(COALESCE(highscore, 0), coins),
           last_active_at = NOW()
       WHERE id = $1
       RETURNING id, username, name, avatar, frame, skin, table_skin, coins, highscore, wins, matches`,
      [id, authoritativeName, avatar || existing.rows[0].avatar, frame || existing.rows[0].frame, skin || existing.rows[0].skin, tableSkin || existing.rows[0].table_skin]
    );
    res.json({ ok: true, player: update.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 3. Leaderboard / Highscore
app.get('/api/leaderboard', async (req, res) => {
  try {
    const list = await query(
      `SELECT id, name, username, avatar, frame, coins, COALESCE(highscore, coins) as highscore, wins, matches
       FROM players
       ORDER BY COALESCE(highscore, coins) DESC, wins DESC, coins DESC
       LIMIT 30`
    );
    res.json({ ok: true, leaderboard: list.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 4. List open rooms (with 7-minute inactivity auto-cleanup)
app.get('/api/rooms', async (req, res) => {
  try {
    // Automatically purge inactive rooms older than 7 minutes (420 seconds) with no activity
    await query(`
      DELETE FROM rooms
      WHERE updated_at < NOW() - INTERVAL '7 minutes'
    `);

    const rooms = await query(`
      SELECT r.id, r.code, r.name, r.mode, r.max_players, r.is_private, r.status, r.created_at, r.updated_at,
             COALESCE(p.name, 'Host') as host_name, COALESCE(p.avatar, '🦊') as host_avatar,
             COUNT(rp.player_id) as current_players
      FROM rooms r
      LEFT JOIN players p ON r.host_id = p.id
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

// 6b. Room Lounge Sync (High-Frequency Poll for 100% reliable real-time lounge sync)
app.get('/api/rooms/:id/sync', async (req, res) => {
  try {
    const roomId = req.params.id;
    const sinceEventId = Number(req.query.since || 0);

    const roomRes = await query('SELECT id, code, name, host_id, mode, max_players, is_private, status FROM rooms WHERE id = $1 OR code = $1', [roomId]);
    if (roomRes.rows.length === 0) return res.status(404).json({ error: 'Ruangan tidak ditemukan' });

    const room = roomRes.rows[0];

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
    `, [room.id]);

    const eventsRes = await query(
      'SELECT id, event_type, payload, created_at FROM room_events WHERE room_id = $1 AND id > $2 ORDER BY id ASC LIMIT 50',
      [room.id, sinceEventId]
    );

    const latestEventId = eventsRes.rows.length > 0 ? eventsRes.rows[eventsRes.rows.length - 1].id : sinceEventId;

    res.json({
      ok: true,
      room,
      players: playersRes.rows,
      events: eventsRes.rows,
      latestEventId
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 7. Join Room / Reconnect to Room
app.post('/api/rooms/:id/join', async (req, res) => {
  try {
    const roomIdent = req.params.id;
    const { playerId, playerName, password } = req.body;
    if (!playerId) return res.status(400).json({ error: 'Player ID required' });

    const roomRes = await query('SELECT * FROM rooms WHERE id = $1 OR code = $1', [roomIdent]);
    if (roomRes.rows.length === 0) return res.status(404).json({ error: 'Ruangan tidak ditemukan' });
    const room = roomRes.rows[0];

    if (room.is_private && room.password && room.password !== password) {
      return res.status(403).json({ error: 'Password ruangan salah!' });
    }

    // Resolve player's effective name and profile
    let effectiveName = playerName ? String(playerName).trim().slice(0, 24) : '';
    const playerInfo = await query('SELECT id, name, avatar, frame FROM players WHERE id = $1', [playerId]);
    if (playerInfo.rows.length > 0 && playerInfo.rows[0].name) {
      effectiveName = playerInfo.rows[0].name.trim();
    } else if (effectiveName) {
      // Ensure player row exists in DB
      await query(
        `INSERT INTO players (id, name, avatar, frame, skin, table_skin, coins, highscore, wins, matches, last_active_at)
         VALUES ($1, $2, '🦊', 'border-amber-400', 'skin-royal', 'table-emerald', 2500, 2500, 0, 0, NOW())
         ON CONFLICT (id) DO UPDATE SET name = $2, last_active_at = NOW()`,
        [playerId, effectiveName]
      );
    }

    // Fetch all current seated players in this room
    const currentSeatsRes = await query(`
      SELECT rp.seat, rp.player_id, rp.is_ready, rp.is_host, rp.is_bot, rp.bot_profile,
             COALESCE(p.name, rp.bot_profile->>'name') as name,
             COALESCE(p.avatar, rp.bot_profile->>'avatar') as avatar
      FROM room_players rp
      LEFT JOIN players p ON rp.player_id = p.id
      WHERE rp.room_id = $1
      ORDER BY rp.seat ASC
    `, [room.id]);

    // Check if player is already seated in this room:
    // Match 1: By exact playerId
    let matchedSeat = currentSeatsRes.rows.find(r => r.player_id === playerId);

    // Match 2: By matching name (case-insensitive) if not already matched
    if (!matchedSeat && effectiveName) {
      matchedSeat = currentSeatsRes.rows.find(r =>
        r.name && r.name.trim().toLowerCase() === effectiveName.toLowerCase()
      );
    }

    // IF MATCHED: Player is reconnecting / reclaiming their existing seat!
    if (matchedSeat) {
      const targetSeat = matchedSeat.seat;

      // If playerId changed (new tab / reconnected with same name), update room_players and game_states
      if (matchedSeat.player_id !== playerId) {
        await query(
          'UPDATE room_players SET player_id = $1, is_bot = FALSE WHERE room_id = $2 AND seat = $3',
          [playerId, room.id, targetSeat]
        );

        if (matchedSeat.is_host) {
          await query('UPDATE rooms SET host_id = $1 WHERE id = $2', [playerId, room.id]);
        }

        // Also update playerId in active game_states if game is running
        const gsRes = await query('SELECT state, version FROM game_states WHERE room_id = $1', [room.id]);
        if (gsRes.rows.length > 0 && gsRes.rows[0].state) {
          const g = gsRes.rows[0].state;
          if (g.players && g.players[targetSeat]) {
            g.players[targetSeat].playerId = playerId;
            g.players[targetSeat].name = effectiveName || g.players[targetSeat].name;
            g.players[targetSeat].isBot = false;
            await query(
              'UPDATE game_states SET version = version + 1, state = $1, updated_at = NOW() WHERE room_id = $2',
              [JSON.stringify(g), room.id]
            );
          }
        }
      }

      await recordRoomEvent(room.id, 'PLAYER_JOINED', {
        playerId,
        name: effectiveName || matchedSeat.name,
        seat: targetSeat,
        reconnected: true
      });

      return res.json({ ok: true, room, seat: targetSeat, reconnected: true });
    }

    // IF NOT MATCHED: New player joining.
    // Cannot join new seat if game is already in progress
    if (room.status !== 'waiting') {
      return res.status(400).json({ error: 'Permainan di ruangan ini sudah dimulai atau selesai!' });
    }

    if (currentSeatsRes.rows.length >= room.max_players) {
      return res.status(400).json({ error: 'Ruangan sudah penuh!' });
    }

    const taken = new Set(currentSeatsRes.rows.map(r => r.seat));
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

    const pName = effectiveName || 'Pemain';

    await recordRoomEvent(room.id, 'PLAYER_JOINED', {
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

    // Check if any human players left
    const remaining = await query('SELECT * FROM room_players WHERE room_id = $1 AND is_bot = FALSE', [roomId]);
    if (remaining.rows.length === 0) {
      await query('DELETE FROM rooms WHERE id = $1', [roomId]);
    } else {
      // Transfer host if host left
      const room = (await query('SELECT host_id FROM rooms WHERE id = $1', [roomId])).rows[0];
      if (room && room.host_id === playerId) {
        const newHost = remaining.rows[0];
        await query('UPDATE rooms SET host_id = $1 WHERE id = $2', [newHost.player_id, roomId]);
        await query('UPDATE room_players SET is_host = TRUE WHERE room_id = $1 AND player_id = $2', [roomId, newHost.player_id]);
      }
      await recordRoomEvent(roomId, 'PLAYER_LEFT', { playerId });
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
    await recordRoomEvent(roomId, 'PLAYER_READY', { playerId, isReady: !!isReady });
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

    await recordRoomEvent(roomId, 'ROOM_UPDATED', {});
    await query("UPDATE rooms SET updated_at = NOW() WHERE id = $1", [roomId]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 10b. Delete / Disband Room (By Host or if inactive >= 7 minutes)
app.post('/api/rooms/:id/delete', async (req, res) => {
  try {
    const roomId = req.params.id;
    const { playerId } = req.body;

    const roomRes = await query('SELECT * FROM rooms WHERE id = $1', [roomId]);
    if (roomRes.rows.length === 0) return res.json({ ok: true, message: 'Ruangan sudah tidak ada' });
    const room = roomRes.rows[0];

    const isHost = room.host_id === playerId;
    const diffMs = Date.now() - new Date(room.updated_at).getTime();
    const isInactive7Min = diffMs >= 7 * 60 * 1000;

    if (!isHost && !isInactive7Min) {
      return res.status(403).json({
        error: 'Hanya host yang bisa membubarkan ruangan, atau tunggu 7 menit tanpa pergerakan.'
      });
    }

    await recordRoomEvent(roomId, 'ROOM_DELETED', {
      roomId,
      reason: isHost ? 'Ruangan dibubarkan oleh Host.' : 'Ruangan otomatis dihapus karena 7 menit tidak ada pergerakan.'
    });

    await query('DELETE FROM rooms WHERE id = $1', [roomId]);
    await query('DELETE FROM room_events WHERE room_id = $1', [roomId]);

    res.json({ ok: true, message: 'Ruangan berhasil dihapus' });
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
      SELECT rp.seat, rp.is_bot, rp.is_bot as "isBot", rp.bot_profile,
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
      return res.status(400).json({ error: 'Minimal butuh 2 pemain atau isi slot kosong dengan bot!' });
    }

    const gameState = initGame(room.mode, playersRes.rows);

    await query(
      `INSERT INTO game_states (room_id, version, state, updated_at)
       VALUES ($1, 1, $2, NOW())
       ON CONFLICT (room_id) DO UPDATE SET version = game_states.version + 1, state = $2, updated_at = NOW()`,
      [roomId, JSON.stringify(gameState)]
    );

    await query("UPDATE rooms SET status = 'playing', updated_at = NOW() WHERE id = $1", [roomId]);

    await recordRoomEvent(roomId, 'GAME_START', { mode: room.mode });

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

    const dbG = await query('SELECT state, version FROM game_states WHERE room_id = $1', [roomId]);
    if (dbG.rows.length === 0) return res.status(404).json({ error: 'Game not found' });

    let g = dbG.rows[0].state;
    // Check 60s turn timer timeout & bot turns
    g = await checkAndApplyTurnTimeout(roomId, g);
    g = await runBotTurnsIfNeeded(roomId, g);

    const vRow = await query('SELECT version FROM game_states WHERE room_id = $1', [roomId]);
    const latestVersion = vRow.rows.length > 0 ? vRow.rows[0].version : dbG.rows[0].version;

    let pIdx = -1;
    if (playerId) {
      pIdx = g.players.findIndex(p => p.playerId === playerId);
    }

    const sanitized = sanitizeGameStateForPlayer(g, pIdx);
    res.json({ ok: true, game: sanitized, mySeat: pIdx, version: latestVersion });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 12b. Game State Sync (High-Frequency Poll for 100% reliable turn/card/event sync)
app.get('/api/game/:roomId/sync', async (req, res) => {
  try {
    const roomId = req.params.roomId;
    const playerId = req.query.playerId;
    const clientVersion = Number(req.query.version || 0);
    const sinceEventId = Number(req.query.since || 0);

    const dbG = await query('SELECT state, version FROM game_states WHERE room_id = $1', [roomId]);
    if (dbG.rows.length === 0) return res.status(404).json({ error: 'Game not found' });

    let g = dbG.rows[0].state;

    // Check 60s turn timeout & execute bot turns if needed
    g = await checkAndApplyTurnTimeout(roomId, g);
    g = await runBotTurnsIfNeeded(roomId, g);

    const vRow = await query('SELECT version FROM game_states WHERE room_id = $1', [roomId]);
    const latestVersion = vRow.rows.length > 0 ? vRow.rows[0].version : dbG.rows[0].version;

    const eventsRes = await query(
      'SELECT id, event_type, payload, created_at FROM room_events WHERE room_id = $1 AND id > $2 ORDER BY id ASC LIMIT 50',
      [roomId, sinceEventId]
    );

    const latestEventId = eventsRes.rows.length > 0 ? eventsRes.rows[eventsRes.rows.length - 1].id : sinceEventId;

    let pIdx = -1;
    if (playerId) {
      pIdx = g.players.findIndex(p => p.playerId === playerId);
    }

    const sanitized = sanitizeGameStateForPlayer(g, pIdx);

    res.json({
      ok: true,
      game: sanitized,
      mySeat: pIdx,
      version: latestVersion,
      events: eventsRes.rows,
      latestEventId
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 13. Game Action
app.post('/api/game/:roomId/action', async (req, res) => {
  try {
    const roomId = req.params.roomId;
    const { playerId, action, payload } = req.body;

    const dbG = await query('SELECT state, version FROM game_states WHERE room_id = $1', [roomId]);
    if (dbG.rows.length === 0) return res.status(404).json({ error: 'Game not found' });

    let g = dbG.rows[0].state;
    // Check if timeout occurred before player acted
    g = await checkAndApplyTurnTimeout(roomId, g);

    const pIdx = g.players.findIndex(p => p.playerId === playerId);
    if (pIdx === -1) return res.status(403).json({ error: 'Player not in game' });

    const result = processGameAction(g, pIdx, action, payload);
    if (!result.ok) {
      return res.status(400).json({ error: result.error });
    }

    // Save to DB and update room activity
    await query(
      'UPDATE game_states SET version = version + 1, state = $1, updated_at = NOW() WHERE room_id = $2',
      [JSON.stringify(g), roomId]
    );
    await query("UPDATE rooms SET updated_at = NOW() WHERE id = $1", [roomId]);

    await recordRoomEvent(roomId, 'GAME_UPDATE', {
      action,
      status: g.status,
      turn: g.turn,
      finished: g.finished,
      winnerText: g.winnerText
    });

    if (g.finished) {
      await handleGameOver(roomId, g);
    }

    const updatedRow = await query('SELECT version FROM game_states WHERE room_id = $1', [roomId]);
    const finalVersion = updatedRow.rows.length > 0 ? updatedRow.rows[0].version : dbG.rows[0].version + 1;

    res.json({ ok: true, game: sanitizeGameStateForPlayer(g, pIdx), mySeat: pIdx, version: finalVersion });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 13b. Explicit Bot Step API (for paced step-by-step bot turns)
app.post('/api/game/:roomId/bot-step', async (req, res) => {
  try {
    const roomId = req.params.roomId;
    const playerId = req.body.playerId;

    const dbG = await query('SELECT state, version FROM game_states WHERE room_id = $1', [roomId]);
    if (dbG.rows.length === 0) return res.status(404).json({ error: 'Game not found' });

    let g = dbG.rows[0].state;
    g = await checkAndApplyTurnTimeout(roomId, g);
    g = await runBotTurnsIfNeeded(roomId, g);

    const vRow = await query('SELECT version FROM game_states WHERE room_id = $1', [roomId]);
    const latestVersion = vRow.rows.length > 0 ? vRow.rows[0].version : dbG.rows[0].version;

    let pIdx = -1;
    if (playerId) {
      pIdx = g.players.findIndex(p => p.playerId === playerId);
    }

    res.json({
      ok: true,
      game: sanitizeGameStateForPlayer(g, pIdx),
      mySeat: pIdx,
      version: latestVersion
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 14. Server-Sent Events (SSE) Stream
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

  const heartbeat = setInterval(() => {
    res.write(': heartbeat\n\n');
  }, 15000);

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

    let seat = -1;
    const dbG = await query('SELECT state FROM game_states WHERE room_id = $1', [roomId]);
    if (dbG.rows.length > 0) {
      const g = dbG.rows[0].state;
      const plIdx = g.players.findIndex(pl => pl.playerId === playerId);
      if (plIdx !== -1) seat = plIdx;
    }
    if (seat === -1) {
      const rp = await query('SELECT seat FROM room_players WHERE room_id = $1 AND player_id = $2', [roomId, playerId]);
      if (rp.rows.length > 0) seat = rp.rows[0].seat;
    }

    await recordRoomEvent(roomId, 'CHAT', {
      playerId,
      sender: p.name,
      avatar: p.avatar,
      message: message.trim(),
      seat
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

    await recordRoomEvent(roomId, 'EMOTE', {
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
