require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const { waitUntil } = require('@vercel/functions');
const { query, transaction } = require('./lib/db');
const { initGame, repairCapsaOpening, prepareGoFishTurn, processGameAction, sanitizeGameStateForPlayer } = require('./lib/engine/games');
const { getBotDecision } = require('./lib/engine/bots');
const { generateMoveCommentary, generateChatReply } = require('./lib/agnes');

const app = express();
app.use(cors());
app.use(express.json());
app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

const GAME_MODES = new Set(['capsa', 'setan', 'sevenup', 'gofish', 'bohong', 'empatsatu', 'minuman', 'blackjack']);
const ROOM_FIELDS = 'id, code, name, host_id, mode, max_players, is_private, status';

class RoomError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function roomError(res, err) {
  if (err instanceof RoomError) return res.status(err.status).json({ error: err.message, code: err.code });
  console.error('Room operation failed:', err);
  return res.status(500).json({ error: 'Operasi ruangan gagal. Silakan coba lagi.' });
}

function publicRoom({ id, code, name, host_id, mode, max_players, is_private, status }) {
  return { id, code, name, host_id, mode, max_players, is_private, status };
}

async function changeRoom(roomIdent, change) {
  const events = [];
  const result = await transaction(async sql => {
    const { rows: [room] } = await sql(
      'SELECT * FROM rooms WHERE id = $1 OR code = UPPER($1) FOR UPDATE', [roomIdent]
    );
    if (!room) throw new RoomError(404, 'Ruangan tidak ditemukan');
    async function emit(type, payload) {
      const id = await insertRoomEvent(sql, room.id, type, payload);
      events.push({ roomId: room.id, id, type, payload });
    }
    return change(room, sql, emit);
  });
  for (const { roomId, ...event } of events) publishRoomEvent(roomId, event);
  return result;
}

function ensureHost(room, playerId) {
  if (room.host_id !== playerId) throw new RoomError(403, 'Aksi ini hanya bisa dilakukan host.');
}


// Password hashing helper
function hashPassword(password) {
  const salt = 'carena_pixel_salt_2026';
  return crypto.scryptSync(password, salt, 32).toString('hex');
}

// In-memory SSE clients per instance (for instant pushes when on same container)
const sseClients = new Map(); // roomId -> Set(res)

async function insertRoomEvent(sql, roomId, type, payload) {
  const { rows: [event] } = await sql(
    'INSERT INTO room_events (room_id, event_type, payload) VALUES ($1, $2, $3) RETURNING id',
    [roomId, type, JSON.stringify(payload)]
  );
  return event.id;
}

function publishRoomEvent(roomId, event) {
  const clients = sseClients.get(roomId);
  if (!clients?.size) return;
  const data = `data: ${JSON.stringify({ ...event, timestamp: Date.now() })}\n\n`;
  for (const client of clients) {
    try {
      client.write(data);
    } catch {
      clients.delete(client);
    }
  }
}

async function recordRoomEvent(roomId, type, payload) {
  try {
    await changeRoom(roomId, (_room, _sql, emit) => emit(type, payload));
  } catch (err) {
    if (err instanceof RoomError && err.status === 404) return;
    console.error('Failed to log room event:', err);
  }
}

// Agnes AI Chat & Move Commentary Handlers
const lastBotChatAt = new Map();
const lastMoveCommentAt = new Map();

async function triggerBotChatReplyIfNeeded(roomId, senderName, userMessage) {
  try {
    const now = Date.now();
    const lastAt = lastBotChatAt.get(roomId) || 0;
    if (now - lastAt < 3500) return; // Debounce 3.5s

    const botSeats = await query(`
      SELECT rp.seat, rp.player_id, rp.bot_profile
      FROM room_players rp
      WHERE rp.room_id = $1 AND rp.is_bot = TRUE
      ORDER BY rp.seat ASC
    `, [roomId]);

    if (botSeats.rows.length === 0) return;

    // Prioritize Agnes AI if present, else pick first bot
    const selectedBot = botSeats.rows.find(b => {
      const p = b.bot_profile || {};
      return p.isAgnes || (p.name && p.name.includes('Agnes'));
    }) || botSeats.rows[0];

    const profile = selectedBot.bot_profile || { name: 'Agnes AI', avatar: '🦊' };
    const botName = profile.name || 'Agnes AI';
    const botAvatar = profile.avatar || '🦊';

    let gameContext = '';
    let seat = selectedBot.seat;
    const gRow = await query('SELECT state FROM game_states WHERE room_id = $1', [roomId]);
    if (gRow.rows.length > 0 && gRow.rows[0].state) {
      const g = gRow.rows[0].state;
      const gameSeat = g.players.findIndex(p => p.playerId === selectedBot.player_id);
      if (gameSeat >= 0) seat = gameSeat;
      gameContext = `Mode: ${g.mode}, Status: ${g.status || ''}`;
    }

    lastBotChatAt.set(roomId, now);

    const reply = await generateChatReply(botName, senderName, userMessage, gameContext);
    if (!reply) return;

    await recordRoomEvent(roomId, 'CHAT', {
      playerId: selectedBot.player_id,
      sender: botName,
      avatar: botAvatar,
      message: reply,
      seat
    });
  } catch (err) {
    console.warn('[Agnes Chat Error]', err.message);
  }
}

async function triggerBotMoveReaction(roomId, botPlayer, mode, action, comboLabel, isFinished) {
  try {
    const now = Date.now();
    const lastAt = lastMoveCommentAt.get(roomId) || 0;
    if (!isFinished && now - lastAt < 5000) return; // Debounce 5s between move comments

    const isAgnes = botPlayer.name && botPlayer.name.includes('Agnes');
    const chance = isFinished ? 1.0 : (isAgnes ? 0.7 : 0.35);
    if (Math.random() > chance) return;

    lastMoveCommentAt.set(roomId, now);

    const comment = await generateMoveCommentary(botPlayer.name, mode, action, comboLabel, isFinished);
    if (!comment) return;

    await recordRoomEvent(roomId, 'CHAT', {
      playerId: botPlayer.playerId || `bot_${botPlayer.id}`,
      sender: botPlayer.name,
      avatar: botPlayer.avatar || '🦊',
      message: comment,
      seat: botPlayer.id
    });
  } catch (err) {
    console.warn('[Agnes Move Reaction Error]', err.message);
  }
}

// Safe public move details: private card faces must never be emitted.
function publicBotMove(g, bot, decision, handBefore) {
  const action = decision?.action || 'pass';
  const payload = decision?.payload || {};
  const move = { seat: bot.id, name: bot.name, action, text: g.status || '', cards: [], faceDownCount: 0 };
  if (['capsa', 'sevenup', 'empatsatu'].includes(g.mode)) {
    const ids = action === 'play' ? (payload.cardIds || (payload.cardId ? [payload.cardId] : []))
      : (action === 'discard' && payload.cardId ? [payload.cardId] : []);
    move.cards = handBefore.filter(c => ids.includes(c.id))
      .map(c => ({ id: c.id, rank: c.rank, suit: c.suit }));
    if (g.lastAction?.by === bot.id) move.text = g.lastAction.text;
  } else if (g.mode === 'minuman' && action === 'draw') {
    const match = /^(10|[2-9AJQK])([♦♣♥♠])$/.exec(g.currentRule?.card || '');
    if (match) move.cards = [{ rank: match[1], suit: match[2] }];
  } else if (g.mode === 'bohong' && action === 'play') {
    move.faceDownCount = Math.min(3, (payload.cardIds || []).length);
    move.text = 'Meletakkan ' + move.faceDownCount + ' kartu tertutup (klaim)';
  } else if (g.mode === 'setan' && action === 'draw') {
    move.faceDownCount = 1;
    move.text = g.lastActionText || move.text;
  } else if (g.mode === 'blackjack' && ['hit','double'].includes(action)) {
    move.faceDownCount = 1;
  } else if (g.mode === 'gofish') {
    move.text = g.lastFishLog || move.text;
  }
  return move;
}

// Only explicit bot-step requests may advance bots. A versioned write prevents
// concurrent clients from skipping/repeating turns on the shared Neon state.
async function runBotTurnsIfNeeded(roomId, g, expectedVersion) {
  const unchanged = () => ({ game: g, version: expectedVersion });
  if (!g || g.finished) return unchanged();
  const bot = g.players[g.turn];
  if (!bot || !(bot.isBot || String(bot.playerId || '').startsWith('bot_'))) return unchanged();
  if (Date.now() - (g.turnStartedAt || 0) < 1200) return unchanged();
  const seat = g.turn;
  bot.isBot = true;
  let handBefore = bot.hand.slice();
  let decision = getBotDecision(g, seat);
  let shown = decision;
  if (!decision) {
    g.turn = (seat + 1) % g.players.length;
    g.turnStartedAt = Date.now();
  } else {
    const outcome = processGameAction(g, seat, decision.action, decision.payload);
    if (!outcome.ok) {
      console.warn('[Bot Action Failed]', bot.name, outcome.error);
      if (g.mode === 'capsa' && !g.mustInclude3D && processGameAction(g, seat, 'pass', {}).ok) {
        shown = { action: 'pass', payload: {} };
      } else {
        g.turn = (seat + 1) % g.players.length;
      }
      g.turnStartedAt = Date.now();
    } else if (g.mode === 'empatsatu' && g.phase === 'discard') {
      const discardHand = g.players[seat].hand.slice();
      const discard = getBotDecision(g, seat);
      if (discard && processGameAction(g, seat, discard.action, discard.payload).ok) {
        handBefore = discardHand;
        shown = discard;
      }
    }
  }
  const move = publicBotMove(g, bot, shown, handBefore);
  const saved = await persistMove(roomId, g, expectedVersion, shown?.action || 'pass', move);
  if (!saved) return readStoredGame(roomId);
  if (shown && process.env.AGNES_API_KEY) {
    waitUntil(triggerBotMoveReaction(roomId, bot, g.mode, shown.action, move.text, g.finished));
  }
  return saved;
}

// Check and enforce 60s max turn timer (Auto Pass / Move if player AFK)
async function checkAndApplyTurnTimeout(roomId, snapshot) {
  const { game, version } = snapshot;
  if (game.finished || !game.turnStartedAt || Date.now() - game.turnStartedAt < (game.turnTimeLimitSec || 60) * 1000) {
    return snapshot;
  }
  const timedOutPlayer = game.players[game.turn];
  if (!timedOutPlayer || timedOutPlayer.isBot || String(timedOutPlayer.playerId || '').startsWith('bot_')) return snapshot;

  const decision = getBotDecision(game, game.turn);
  if (!decision || !processGameAction(game, game.turn, decision.action, decision.payload).ok) return snapshot;

  game.status = `⏱️ Waktu habis! ${timedOutPlayer.name} otomatis Pass/Jalan. ${game.status || ''}`;
  return await persistMove(roomId, game, version, 'TIMEOUT_AUTO') || await readStoredGame(roomId);
}

async function persistMove(roomId, game, expectedVersion, action, move) {
  return changeRoom(roomId, async (room, sql, emit) => {
    if (room.status !== 'playing') return null;
    const { rows: [saved] } = await sql(
      'UPDATE game_states SET version = version + 1, state = $1, updated_at = NOW() WHERE room_id = $2 AND version = $3 RETURNING version',
      [JSON.stringify(game), room.id, expectedVersion]
    );
    if (!saved) return null;

    await sql('UPDATE rooms SET status = $2, updated_at = NOW() WHERE id = $1',
      [room.id, game.finished ? 'finished' : 'playing']);
    await emit('GAME_UPDATE', {
      action, move, mode: game.mode, status: game.status, turn: game.turn, finished: game.finished,
      winnerText: game.winnerText, version: saved.version
    });
    if (game.finished) await handleGameOver(game, sql, emit);
    return { game, version: saved.version };
  });
}

async function handleGameOver(game, sql, emit) {
  const humans = game.players.filter(p => !p.isBot);
  await sql('SELECT id FROM players WHERE id = ANY($1) ORDER BY id FOR UPDATE', [humans.map(p => p.playerId)]);
  const winner = humans.find(p => p.id === game.winnerIdx);
  const losers = humans.filter(p => p !== winner).map(p => p.playerId);
  // Keep the score and the winning move in the same transaction.
  await sql(
    `UPDATE players
     SET coins = coins + 50, highscore = GREATEST(COALESCE(highscore, 0), coins + 50),
         matches = matches + 1, last_active_at = NOW()
     WHERE id = ANY($1)`,
    [losers]
  );
  if (winner) {
    await sql(
      `UPDATE players
       SET coins = coins + 500, highscore = GREATEST(COALESCE(highscore, 0), coins + 500),
           wins = wins + 1, matches = matches + 1, last_active_at = NOW()
       WHERE id = $1`,
      [winner.playerId]
    );
  }
  await emit('GAME_OVER', { winnerIdx: game.winnerIdx, winnerText: game.winnerText, status: game.status });
}

async function readStoredGame(roomId) {
  const { rows: [row] } = await query('SELECT state, version FROM game_states WHERE room_id = $1', [roomId]);
  if (!row) throw new RoomError(404, 'Permainan tidak ditemukan');
  return { game: row.state, version: row.version };
}

function gameSeat(game, playerId) {
  const seat = game.players.findIndex(p => p.playerId === playerId && !p.isBot);
  if (seat < 0) throw new RoomError(403, 'Pemain belum bergabung di meja ini.', 'ROOM_MEMBERSHIP_REQUIRED');
  return seat;
}

async function loadGame(roomId, playerId) {
  const snapshot = await readStoredGame(roomId);
  const { game, version } = snapshot;
  gameSeat(game, playerId);
  if (game.finished) return snapshot;

  const requiredOpening = game.mustInclude3D;
  repairCapsaOpening(game);
  let repaired = requiredOpening !== game.mustInclude3D;
  if (game.mode === 'gofish') {
    const { turn } = game;
    const stockCount = game.deck.length;
    prepareGoFishTurn(game);
    repaired = game.finished || game.turn !== turn || game.deck.length !== stockCount;
  }
  if (!repaired) return snapshot;
  return await persistMove(roomId, game, version, 'RESUME') || await readStoredGame(roomId);
}

function gameResponse({ game, version }, playerId, clientVersion) {
  const mySeat = gameSeat(game, playerId);
  return {
    ok: true,
    game: version !== clientVersion ? sanitizeGameStateForPlayer(game, mySeat) : null,
    mySeat,
    version,
    serverTime: Date.now(),
  };
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

    await query(`
      UPDATE game_states gs
      SET state = jsonb_set(gs.state, '{players}', (
        SELECT jsonb_agg(
          CASE WHEN player->>'playerId' = $1 THEN jsonb_set(player, '{name}', to_jsonb($2::text))
               ELSE player END
          ORDER BY seat
        )
        FROM jsonb_array_elements(gs.state->'players') WITH ORDINALITY AS seated(player, seat)
      )),
      version = gs.version + 1,
      updated_at = NOW()
      WHERE EXISTS (SELECT 1 FROM room_players rp WHERE rp.room_id = gs.room_id AND rp.player_id = $1)
    `, [id, cleanName]);

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

    const { rows: [player] } = await query(
      `INSERT INTO players (id, name, avatar, frame, skin, table_skin)
       VALUES ($1, $2, COALESCE($3, '🦊'), COALESCE($4, 'border-amber-400'),
               COALESCE($5, 'skin-royal'), COALESCE($6, 'table-emerald'))
       ON CONFLICT (id) DO UPDATE
       SET avatar = COALESCE($3, players.avatar),
           frame = COALESCE($4, players.frame),
           skin = COALESCE($5, players.skin),
           table_skin = COALESCE($6, players.table_skin),
           highscore = GREATEST(COALESCE(players.highscore, 0), players.coins),
           last_active_at = NOW()
       RETURNING id, username, name, avatar, frame, skin, table_skin, coins, highscore, wins, matches`,
      [id, name || 'Pemain', avatar || null, frame || null, skin || null, tableSkin || null]
    );
    res.json({ ok: true, player });
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
    await query(`
      WITH expired AS (
        DELETE FROM rooms
        WHERE updated_at < NOW() - INTERVAL '7 minutes'
        RETURNING id
      )
      DELETE FROM room_events WHERE room_id IN (SELECT id FROM expired)
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
    const { name, mode, maxPlayers = 4, password = '', isPrivate, hostId } = req.body;
    const roomName = typeof name === 'string' ? name.trim() : '';
    if (!roomName || roomName.length > 64 || !GAME_MODES.has(mode) ||
        !Number.isInteger(maxPlayers) || maxPlayers < 2 || maxPlayers > 8 ||
        typeof hostId !== 'string' || !hostId || hostId.length > 64) {
      throw new RoomError(400, 'Nama, mode, host, atau jumlah pemain tidak valid.');
    }
    if (isPrivate && (typeof password !== 'string' || !password || password.length > 64)) {
      throw new RoomError(400, 'Masukkan password ruangan dengan maksimal 64 karakter.');
    }

    const room = await transaction(async sql => {
      const roomId = `room_${crypto.randomUUID()}`;
      for (let attempt = 0; attempt < 8; attempt++) {
        const code = `KRT-${crypto.randomInt(1000, 10000)}`;
        const { rows: [created] } = await sql(
          `INSERT INTO rooms (id, code, name, host_id, mode, max_players, password, is_private, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'waiting')
           ON CONFLICT (code) DO NOTHING
           RETURNING ${ROOM_FIELDS}`,
          [roomId, code, roomName, hostId, mode, maxPlayers, isPrivate ? password : '', !!isPrivate]
        );
        if (!created) continue;

        await sql(
          `INSERT INTO room_players (room_id, player_id, seat, is_ready, is_host, is_bot)
           VALUES ($1, $2, 0, TRUE, TRUE, FALSE)`,
          [roomId, hostId]
        );
        return created;
      }
      throw new RoomError(503, 'Kode ruangan belum tersedia. Silakan coba lagi.');
    });

    res.json({ ok: true, room });
  } catch (err) {
    roomError(res, err);
  }
});

async function readRoom(roomIdent) {
  const { rows: [room] } = await query(
    `SELECT ${ROOM_FIELDS} FROM rooms WHERE id = $1 OR code = UPPER($1)`, [roomIdent]
  );
  if (!room) throw new RoomError(404, 'Ruangan tidak ditemukan');
  return room;
}

async function readRoomPlayers(room, playerId) {
  const { rows: players } = await query(`
    SELECT rp.seat, rp.is_ready, rp.is_host, rp.is_bot,
           rp.player_id AS id,
           COALESCE(p.name, rp.bot_profile->>'name', 'Pemain') AS name,
           COALESCE(p.avatar, rp.bot_profile->>'avatar', '🦊') AS avatar,
           COALESCE(p.frame, rp.bot_profile->>'frame', 'border-amber-400') AS frame,
           COALESCE(p.skin, 'skin-royal') AS skin,
           COALESCE(p.table_skin, 'table-emerald') AS table_skin
    FROM room_players rp
    LEFT JOIN players p ON rp.player_id = p.id
    WHERE rp.room_id = $1
    ORDER BY rp.seat
  `, [room.id]);
  if (room.is_private && !players.some(player => player.id === playerId && !player.is_bot)) {
    throw new RoomError(403, 'Pemain belum bergabung di ruangan ini.', 'ROOM_MEMBERSHIP_REQUIRED');
  }
  return players;
}

async function eventsSince(roomId, since = '0') {
  const cursor = typeof since === 'string' && /^[0-9]{1,18}$/.test(since) ? since : '0';
  const { rows: events } = await query(
    'SELECT id, event_type, payload, created_at FROM room_events WHERE room_id = $1 AND id > $2 ORDER BY id LIMIT 50',
    [roomId, cursor]
  );
  return { events, latestEventId: events.at(-1)?.id ?? cursor };
}

// Room details remain available by either invite code or room ID.
app.get('/api/rooms/:id', async (req, res) => {
  try {
    const room = await readRoom(req.params.id);
    const players = await readRoomPlayers(room, req.query.playerId);
    res.json({ ok: true, room, players });
  } catch (err) {
    roomError(res, err);
  }
});

app.get('/api/rooms/:id/sync', async (req, res) => {
  try {
    const room = await readRoom(req.params.id);
    const players = await readRoomPlayers(room, req.query.playerId);
    res.json({ ok: true, room, players, ...await eventsSince(room.id, req.query.since) });
  } catch (err) {
    roomError(res, err);
  }
});

// 7. Join Room / Reconnect to Room
app.post('/api/rooms/:id/join', async (req, res) => {
  try {
    const { playerId, playerName, password } = req.body;
    if (typeof playerId !== 'string' || !playerId || playerId.length > 64 || playerId.startsWith('bot_')) {
      throw new RoomError(400, 'ID pemain tidak valid.');
    }

    const result = await changeRoom(req.params.id, async (room, sql, emit) => {
      if (room.is_private && room.password && room.password !== password) {
        throw new RoomError(403, 'Password ruangan salah!', 'ROOM_PASSWORD_REQUIRED');
      }
      const seats = await sql('SELECT seat, player_id FROM room_players WHERE room_id = $1', [room.id]);
      const existing = seats.rows.find(p => p.player_id === playerId);
      if (!existing && room.status !== 'waiting') {
        throw new RoomError(409, 'Permainan di ruangan ini sudah dimulai atau selesai.');
      }
      if (!existing && seats.rows.length >= room.max_players) {
        throw new RoomError(409, 'Ruangan sudah penuh.');
      }

      const displayName = (typeof playerName === 'string' && playerName.trim().slice(0, 24)) || 'Pemain';
      await sql('INSERT INTO players (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING',
        [playerId, displayName]);
      await sql('UPDATE rooms SET updated_at = NOW() WHERE id = $1', [room.id]);
      if (existing) return { room: publicRoom(room), seat: existing.seat, reconnected: true };

      const taken = new Set(seats.rows.map(p => p.seat));
      const seat = Array.from({ length: room.max_players }, (_, index) => index).find(index => !taken.has(index));
      await sql('INSERT INTO room_players (room_id, player_id, seat) VALUES ($1, $2, $3)', [room.id, playerId, seat]);
      const { rows: [player] } = await sql('SELECT name FROM players WHERE id = $1', [playerId]);
      await emit('PLAYER_JOINED', { playerId, name: player.name, seat });
      return { room: publicRoom(room), seat };
    });
    res.json({ ok: true, ...result });
  } catch (err) {
    roomError(res, err);
  }
});

// 8. Leave Room
app.post('/api/rooms/:id/leave', async (req, res) => {
  try {
    const { playerId } = req.body;
    await changeRoom(req.params.id, async (room, sql, emit) => {
      // Keep seats for reconnects during a round.
      if (room.status === 'playing') return;
      const removed = await sql('DELETE FROM room_players WHERE room_id = $1 AND player_id = $2 AND NOT is_bot',
        [room.id, playerId]);
      if (!removed.rowCount) return;

      const { rows: [nextHost] } = await sql(
        'SELECT player_id FROM room_players WHERE room_id = $1 AND NOT is_bot ORDER BY seat LIMIT 1', [room.id]
      );
      if (!nextHost) {
        await sql('DELETE FROM rooms WHERE id = $1', [room.id]);
        await sql('DELETE FROM room_events WHERE room_id = $1', [room.id]);
        return;
      }
      if (room.host_id === playerId) {
        await sql('UPDATE rooms SET host_id = $1 WHERE id = $2', [nextHost.player_id, room.id]);
        await sql('UPDATE room_players SET is_host = TRUE WHERE room_id = $1 AND player_id = $2',
          [room.id, nextHost.player_id]);
      }
      await sql('UPDATE rooms SET updated_at = NOW() WHERE id = $1', [room.id]);
      await emit('PLAYER_LEFT', { playerId });
    });
    res.json({ ok: true });
  } catch (err) {
    roomError(res, err);
  }
});

// 9. Ready toggle
app.post('/api/rooms/:id/ready', async (req, res) => {
  try {
    const { playerId, isReady } = req.body;
    await changeRoom(req.params.id, async (room, sql, emit) => {
      if (room.status !== 'waiting') throw new RoomError(409, 'Permainan sudah dimulai.');
      const updated = await sql('UPDATE room_players SET is_ready = $1 WHERE room_id = $2 AND player_id = $3 AND NOT is_bot',
        [!!isReady, room.id, playerId]);
      if (!updated.rowCount) throw new RoomError(403, 'Pemain belum bergabung di ruangan ini.');
      await sql('UPDATE rooms SET updated_at = NOW() WHERE id = $1', [room.id]);
      await emit('PLAYER_READY', { playerId, isReady: !!isReady });
    });
    res.json({ ok: true });
  } catch (err) {
    roomError(res, err);
  }
});

// 10. Fill Empty Seats with Bots (Powered by Agnes AI)
const BOT_PROFILES = [
  { name: 'Agnes AI', avatar: '🦊', frame: 'border-amber-400', isAgnes: true },
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
    await changeRoom(req.params.id, async (room, sql, emit) => {
      ensureHost(room, req.body.hostId);
      if (room.status !== 'waiting') throw new RoomError(409, 'Permainan sudah dimulai.');
      const current = await sql('SELECT seat FROM room_players WHERE room_id = $1', [room.id]);
      const taken = new Set(current.rows.map(r => r.seat));
      let botIdx = 0;
      for (let seat = 0; seat < room.max_players; seat++) {
        if (taken.has(seat)) continue;
        await sql(
          `INSERT INTO room_players (room_id, player_id, seat, is_ready, is_bot, bot_profile)
           VALUES ($1, $2, $3, TRUE, TRUE, $4)`,
          [room.id, `bot_${crypto.randomUUID()}`, seat, JSON.stringify(BOT_PROFILES[botIdx++])]
        );
      }
      if (botIdx) {
        await sql('UPDATE rooms SET updated_at = NOW() WHERE id = $1', [room.id]);
        await emit('ROOM_UPDATED', {});
      }
    });
    res.json({ ok: true });
  } catch (err) {
    roomError(res, err);
  }
});

// 10b. Delete / Disband Room (By Host or if inactive >= 7 minutes)
app.post('/api/rooms/:id/delete', async (req, res) => {
  try {
    await changeRoom(req.params.id, async (room, sql) => {
      if (Date.now() - new Date(room.updated_at).getTime() < 7 * 60 * 1000) {
        ensureHost(room, req.body.playerId);
      }
      await sql('DELETE FROM rooms WHERE id = $1', [room.id]);
      await sql('DELETE FROM room_events WHERE room_id = $1', [room.id]);
    });
    res.json({ ok: true, message: 'Ruangan berhasil dihapus' });
  } catch (err) {
    if (err instanceof RoomError && err.status === 404) return res.json({ ok: true });
    roomError(res, err);
  }
});

// 11. Start Game
app.post('/api/rooms/:id/start', async (req, res) => {
  try {
    const { hostId, version } = req.body;
    await changeRoom(req.params.id, async (room, sql, emit) => {
      ensureHost(room, hostId);
      if (room.status === 'playing') return;
      if (room.status === 'finished' && version !== undefined) {
        const { rows: [previous] } = await sql('SELECT version FROM game_states WHERE room_id = $1', [room.id]);
        if (previous?.version !== version) throw new RoomError(409, 'Meja sudah berubah. Sinkronkan dahulu.');
      }

      const players = await sql(`
        SELECT rp.is_bot, rp.player_id AS id,
               COALESCE(p.name, rp.bot_profile->>'name', 'Pemain') AS name,
               COALESCE(p.avatar, rp.bot_profile->>'avatar', '🦊') AS avatar,
               COALESCE(p.frame, rp.bot_profile->>'frame', 'border-amber-400') AS frame
        FROM room_players rp
        LEFT JOIN players p ON rp.player_id = p.id
        WHERE rp.room_id = $1
        ORDER BY rp.seat
      `, [room.id]);
      if (players.rows.length < 2) throw new RoomError(400, 'Minimal butuh 2 pemain atau isi slot kosong dengan bot!');

      const game = initGame(room.mode, players.rows);
      const { rows: [saved] } = await sql(
        `INSERT INTO game_states (room_id, version, state, updated_at)
         VALUES ($1, 1, $2, NOW())
         ON CONFLICT (room_id) DO UPDATE SET version = game_states.version + 1, state = $2, updated_at = NOW()
         RETURNING version`,
        [room.id, JSON.stringify(game)]
      );
      await sql('UPDATE rooms SET status = $2, updated_at = NOW() WHERE id = $1',
        [room.id, game.finished ? 'finished' : 'playing']);
      await emit('GAME_START', { mode: room.mode, version: saved.version });
      if (game.finished) await handleGameOver(game, sql, emit);
    });
    res.json({ ok: true });
  } catch (err) {
    roomError(res, err);
  }
});

// 12. Get Game State
app.get('/api/game/:roomId', async (req, res) => {
  try {
    const { roomId } = req.params;
    const { playerId } = req.query;
    const snapshot = await checkAndApplyTurnTimeout(roomId, await loadGame(roomId, playerId));
    res.json(gameResponse(snapshot, playerId));
  } catch (err) {
    roomError(res, err);
  }
});

// 12b. Game sync uses the database across server instances and sends only changed snapshots.
app.get('/api/game/:roomId/sync', async (req, res) => {
  try {
    const { roomId } = req.params;
    const { playerId } = req.query;
    const snapshot = await checkAndApplyTurnTimeout(roomId, await loadGame(roomId, playerId));
    const events = await eventsSince(roomId, req.query.since);
    res.json({ ...gameResponse(snapshot, playerId, Number(req.query.version)), ...events });
  } catch (err) {
    roomError(res, err);
  }
});

// 13. Game Action
app.post('/api/game/:roomId/action', async (req, res) => {
  try {
    const { roomId } = req.params;
    const { playerId, action, payload, version } = req.body;
    const snapshot = await loadGame(roomId, playerId);
    const { game } = snapshot;
    const pIdx = gameSeat(game, playerId);
    if (version !== undefined && version !== snapshot.version) {
      throw new RoomError(409, 'Meja sudah berubah. Sinkronkan dan ulangi aksi.');
    }
    if (!game.finished && game.turnStartedAt && Date.now() - game.turnStartedAt >= (game.turnTimeLimitSec || 60) * 1000) {
      await checkAndApplyTurnTimeout(roomId, snapshot);
      throw new RoomError(409, 'Giliran habis. Sinkronkan meja dahulu.');
    }

    const result = processGameAction(game, pIdx, action, payload);
    if (!result.ok) throw new RoomError(400, result.error);
    const saved = await persistMove(roomId, game, snapshot.version, action);
    if (!saved) throw new RoomError(409, 'Meja sudah berubah. Sinkronkan dan ulangi aksi.');
    res.json(gameResponse(saved, playerId));
  } catch (err) {
    roomError(res, err);
  }
});

// 13b. Explicit bot steps let the frontend pace each visible AI move.
app.post('/api/game/:roomId/bot-step', async (req, res) => {
  try {
    const { roomId } = req.params;
    const { playerId, version } = req.body;
    const snapshot = await loadGame(roomId, playerId);
    const updated = version === undefined || version === snapshot.version
      ? await runBotTurnsIfNeeded(roomId, snapshot.game, snapshot.version)
      : snapshot;
    res.json(gameResponse(updated, playerId));
  } catch (err) {
    roomError(res, err);
  }
});

// 14. Server-Sent Events (SSE) Stream
app.get('/api/events/:roomId', async (req, res) => {
  let room;
  try {
    room = await readRoom(req.params.roomId);
    if (room.is_private) await readRoomPlayers(room, req.query.playerId);
  } catch (err) {
    return roomError(res, err);
  }
  const roomId = room.id;
  if (res.destroyed) return;

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

  res.on('close', () => {
    clearInterval(heartbeat);
    const clients = sseClients.get(roomId);
    if (clients) {
      clients.delete(res);
      if (clients.size === 0) sseClients.delete(roomId);
    }
  });
});

async function roomParticipant(roomId, playerId, sql) {
  const { rows: [member] } = await sql(
    `SELECT rp.seat, COALESCE(p.name, 'Pemain') AS name,
            COALESCE(p.avatar, '🦊') AS avatar, gs.state
     FROM room_players rp
     LEFT JOIN players p ON rp.player_id = p.id
     LEFT JOIN game_states gs ON gs.room_id = rp.room_id
     WHERE rp.room_id = $1 AND rp.player_id = $2 AND NOT rp.is_bot`,
    [roomId, playerId]
  );
  if (!member) throw new RoomError(403, 'Pemain belum bergabung di ruangan ini.', 'ROOM_MEMBERSHIP_REQUIRED');
  const gameSeat = member.state?.players.findIndex(p => p.playerId === playerId);
  return { ...member, seat: gameSeat >= 0 ? gameSeat : member.seat };
}

// 15. Send Chat
app.post('/api/events/:roomId/chat', async (req, res) => {
  try {
    const { playerId, message } = req.body;
    const trimmed = typeof message === 'string' ? message.trim() : '';
    if (!trimmed || trimmed.length > 300) throw new RoomError(400, 'Pesan harus berisi 1–300 karakter.');

    const sender = await changeRoom(req.params.roomId, async (room, sql, emit) => {
      const { name, avatar, seat } = await roomParticipant(room.id, playerId, sql);
      await sql('UPDATE rooms SET updated_at = NOW() WHERE id = $1', [room.id]);
      await emit('CHAT', { playerId, sender: name, avatar, message: trimmed, seat });
      return name;
    });

    res.json({ ok: true });
    if (process.env.AGNES_API_KEY) waitUntil(triggerBotChatReplyIfNeeded(req.params.roomId, sender, trimmed));
  } catch (err) {
    roomError(res, err);
  }
});

// 16. Send Emote
app.post('/api/events/:roomId/emote', async (req, res) => {
  try {
    const { playerId, emote } = req.body;
    if (typeof emote !== 'string' || !emote.trim() || emote.length > 24) {
      throw new RoomError(400, 'Emote tidak valid.');
    }
    await changeRoom(req.params.roomId, async (room, sql, emit) => {
      const { seat } = await roomParticipant(room.id, playerId, sql);
      await sql('UPDATE rooms SET updated_at = NOW() WHERE id = $1', [room.id]);
      await emit('EMOTE', { playerId, seat, emote });
    });
    res.json({ ok: true });
  } catch (err) {
    roomError(res, err);
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
