// ==================== 8-BIT AUDIO SYNTHESIZER ====================
const SFX = (() => {
  let ctx = null;
  let enabled = true;
  function init() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC) ctx = new AC();
    }
    if (ctx && ctx.state === 'suspended') ctx.resume();
  }
  function tone(freq, dur, type = 'square', vol = 0.06, delay = 0) {
    if (!enabled) return;
    init();
    if (!ctx) return;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, ctx.currentTime + delay);
    gain.gain.setValueAtTime(vol, ctx.currentTime + delay);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + delay + dur);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(ctx.currentTime + delay);
    osc.stop(ctx.currentTime + delay + dur);
  }
  return {
    toggle() { enabled = !enabled; return enabled; },
    isEnabled() { return enabled; },
    card() { tone(520, 0.06, 'square', 0.06); tone(780, 0.05, 'square', 0.05, 0.03); },
    emote() { tone(660, 0.07, 'square', 0.06); tone(990, 0.1, 'square', 0.06, 0.06); },
    chat() { tone(440, 0.06, 'square', 0.04); },
    alert() { tone(320, 0.12, 'sawtooth', 0.07); tone(240, 0.16, 'sawtooth', 0.07, 0.1); },
    win() { tone(523, 0.1, 'square', 0.07); tone(659, 0.1, 'square', 0.07, 0.1); tone(784, 0.1, 'square', 0.07, 0.2); tone(1046, 0.2, 'square', 0.07, 0.3); }
  };
})();

// ==================== GAME CONFIG & MODES ====================
const GAME_MODES = [
  {
    id: 'capsa', name: 'Capsa Banting', icon: '👑', tag: 'Strategi',
    desc: 'Pemegang 3♦ jalan pertama! Single, Pair, Triple, & 5 Kartu (Straight, Flush, Full House, 4 of a Kind).',
    rules: 'Pemain yang memegang 3 Wajik (3♦) jalan pertama dan wajib menyertakan 3♦ di langkah pembuka. Kombinasi sah: Single, Pair, Triple, dan 5 Kartu (Straight < Flush < Full House < 4 of a Kind < Straight Flush). Urutan angka: 3 terendah hingga 2 tertinggi; kembang: ♦ < ♣ < ♥ < ♠. Pemain pertama yang kartunya habis menang!'
  },
  {
    id: 'setan', name: 'Setan-setan', icon: '👹', tag: 'Santai',
    desc: 'Cabut kartu dari pemain sebelah, buang pasangan otomatis, hindari kartu SETAN!',
    rules: 'Satu kartu Joker (SETAN) dimasukkan ke dek. Setiap pasang angka kembar otomatis dibuang. Saat giliranmu, klik salah satu kartu tertutup milik pemain sebelumnya. Pemain terakhir yang masih memegang kartu SETAN kalah!'
  },
  {
    id: 'sevenup', name: 'Seven Up', icon: '7️⃣', tag: 'Klasik',
    desc: 'Susun urutan kartu naik & turun mulai dari angka 7 di setiap kembang.',
    rules: 'Permainan dimulai dengan menurunkan angka 7 di tiap kembang (♠ ♥ ♦ ♣). Setelah 7 terbuka, sambung angka 6 turun ke As atau 8 naik ke King. Jika tidak ada kartu valid, tekan Pass. Yang kartunya habis duluan menang!'
  },
  {
    id: 'gofish', name: 'Go Fish', icon: '🐟', tag: 'Memori',
    desc: 'Minta angka kartu ke pemain lain untuk mengumpulkan 4 kartu kembar (Book).',
    rules: 'Saat giliranmu, pilih salah satu lawan dan pilih angka yang ada di tanganmu, lalu tekan "Minta Kartu". Jika lawan punya, kartu jadi milikmu dan jalan lagi! Jika tidak, kamu "Go Fish" (ambil 1 dari dek).'
  },
  {
    id: 'bohong', name: 'Bohong-bohongan', icon: '🤥', tag: 'Bluffing',
    desc: 'Taruh kartu tertutup sambil mengklaim angka target. Tuduh jika lawan berbohong!',
    rules: 'Angka target berputar dari As → 2 → 3 ... → K. Saat giliranmu, pilih 1–3 kartu (boleh jujur atau bohong!) lalu tekan "Taruh Tertutup". Lawan bisa menekan "Tuduh Bohong!". Jika terbukti bohong, penaruh mengambil semua tumpukan meja!'
  },
  {
    id: 'empatsatu', name: '4-1 (Empat Satu)', icon: '🎯', tag: 'Cepat',
    desc: 'Kumpulkan 4 kartu sekembang dengan total poin mendekati atau tepat 41.',
    rules: 'Tiap pemain memegang 4 kartu. Nilai kartu: As=11, K/Q/J=10, 2–10 sesuai angka. Ambil 1 kartu dari Dek atau Buangan, lalu buang 1 kartu. Tekan "Tutup (41!)" saat total sekembangmu tinggi.'
  },
  {
    id: 'minuman', name: 'Minuman (Party)', icon: '🍻', tag: 'Tongkrongan',
    desc: 'Tarik kartu dari lingkaran meja, tiap angka memicu tantangan seru bareng teman!',
    rules: 'Mode party santai! Setiap giliran, tarik 1 kartu dari lingkaran tengah. Setiap angka (As sampai King) punya aturan tantangan seru. King ke-4 menyelesaikan ronde!'
  },
  {
    id: 'blackjack', name: 'Blackjack 21', icon: '🎰', tag: 'Kasino',
    desc: 'Lawan Bandar! Dekati total 21 tanpa melebihi (Bust) dengan Hit, Stand, atau Double.',
    rules: 'Semua pemain bertaruh koin melawan Bandar. Pilih Hit untuk tambah kartu, Stand untuk berhenti, atau Double untuk 2x taruhan. Total terdekat ke 21 menang koin!'
  }
];

const CARD_SKINS = [
  { id: 'skin-royal', name: 'Klasik Royal', previewBg: 'from-blue-900 to-indigo-950', border: 'border-amber-400' },
  { id: 'skin-batik', name: 'Batik Nusantara', previewBg: 'from-amber-800 to-amber-950', border: 'border-amber-300' },
  { id: 'skin-cyber', name: 'Neon Cyberpunk', previewBg: 'from-slate-950 to-indigo-900', border: 'border-cyan-400' },
  { id: 'skin-sakura', name: 'Sakura Blossom', previewBg: 'from-rose-700 to-pink-500', border: 'border-pink-200' },
  { id: 'skin-obsidian', name: 'Obsidian Gold', previewBg: 'from-zinc-900 to-zinc-800', border: 'border-yellow-400' }
];

const TABLE_SKINS = [
  { id: 'table-emerald', name: 'Zamrud Klasik', previewBg: 'from-emerald-800 to-green-950', border: 'border-amber-700', icon: '🟩' },
  { id: 'table-crimson', name: 'Beludru Merah', previewBg: 'from-red-800 to-rose-950', border: 'border-amber-500', icon: '🟥' },
  { id: 'table-ocean', name: 'Samudra Royal', previewBg: 'from-blue-800 to-indigo-950', border: 'border-sky-400', icon: '🟦' },
  { id: 'table-cyber', name: 'Cyber Neon', previewBg: 'from-indigo-950 to-purple-950', border: 'border-cyan-400', icon: '🟪' },
  { id: 'table-tavern', name: 'Kayu Warung', previewBg: 'from-amber-900 to-orange-950', border: 'border-amber-600', icon: '🟫' }
];

const AVATARS = ['🦊', '🐼', '🐯', '🦁', '🐸', '🐙', '🤖', '👾', '🤠', '🥷'];
const AVATAR_FRAMES = [
  { id: 'border-amber-400', name: 'Emas Royal' },
  { id: 'border-cyan-400', name: 'Neon Cyan' },
  { id: 'border-rose-400', name: 'Ruby Merah' },
  { id: 'border-emerald-400', name: 'Zamrud' },
  { id: 'border-purple-400', name: 'Amethyst' }
];

const EMOTES = [
  { icon: '😂', label: 'Ngakak' },
  { icon: '🔥', label: 'GG' },
  { icon: '😱', label: 'Kaget' },
  { icon: '😈', label: 'Licik' },
  { icon: '👏', label: 'Mantap' },
  { icon: '😭', label: 'Pasrah' },
  { icon: '🍻', label: 'Cheers' },
  { icon: '🃏', label: 'Hoki' }
];

const SUITS = ['♦', '♣', '♥', '♠'];
const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];

// ==================== APP STATE ====================
const app = {
  view: 'lobby', // 'lobby', 'lounge', 'game'
  player: {
    id: localStorage.getItem('carena_player_id') || ('usr_' + Math.floor(100000 + Math.random() * 900000)),
    name: localStorage.getItem('carena_player_name') || ('Pemain-' + Math.floor(100 + Math.random() * 900)),
    username: localStorage.getItem('carena_player_username') || null,
    avatar: localStorage.getItem('carena_player_avatar') || '🦊',
    frame: localStorage.getItem('carena_player_frame') || 'border-amber-400',
    skin: localStorage.getItem('carena_skin') || 'skin-royal',
    tableSkin: localStorage.getItem('carena_table_skin') || 'table-emerald',
    coins: 2500,
    highscore: 2500,
    wins: 0,
    matches: 0
  },
  currentRoom: null, // Active room object
  roomPlayers: [], // Seated players in lounge
  mySeat: -1,
  game: null, // Active game state
  gameVersion: 0,
  lastEventId: 0,
  selectedCardIds: new Set(),
  chatOpen: false,
  unreadChat: 0,
  sseSource: null,
  syncTimer: null,
  pendingJoinRoom: null
};

localStorage.setItem('carena_player_id', app.player.id);
localStorage.setItem('carena_player_name', app.player.name);

// ==================== UTILITIES ====================
function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function showToast(msg, type = 'info') {
  const box = document.getElementById('toast-container');
  const t = document.createElement('div');
  const borderCol = type === 'error' ? 'border-rose-500 text-rose-300' :
    type === 'warn' ? 'border-amber-400 text-amber-300' :
    type === 'success' ? 'border-emerald-400 text-emerald-300' : 'border-sky-400 text-sky-200';
  t.className = `bg-slate-950/95 border-2 ${borderCol} px-3.5 py-2 text-xs font-bold shadow-2xl flex items-center gap-2 pixel-box`;
  t.innerHTML = `<span>${type === 'error' ? '⚠️' : type === 'success' ? '✅' : 'ℹ️'}</span><span>${escapeHtml(msg)}</span>`;
  box.appendChild(t);
  setTimeout(() => { t.remove(); }, 3200);
}

function isRedSuit(suit) {
  return suit === '♥' || suit === '♦';
}

function cardHTML(card, { small = false, faceDown = false, selectable = false, selected = false, extraClass = '' } = {}) {
  const sizeCls = small ? 'w-11 h-16 text-xs' : 'w-14 h-20 sm:w-16 sm:h-24 text-sm';
  if (faceDown || !card) {
    return `<div class="playing-card card-back ${sizeCls} ${selectable ? 'selectable cursor-pointer' : ''} ${extraClass} flex items-center justify-center" data-card-id="${card ? card.id : ''}">
      <span class="text-white/40 text-lg font-black">✦</span>
    </div>`;
  }
  if (card.isJoker) {
    return `<div class="playing-card card-front ${sizeCls} ${selectable ? 'selectable cursor-pointer' : ''} ${selected ? 'selected' : ''} ${extraClass} flex flex-col items-center justify-center p-1 border-rose-500" data-card-id="${card.id}">
      <span class="text-xl sm:text-2xl leading-none">👹</span>
      <span class="text-[9px] font-extrabold text-rose-600 mt-0.5 tracking-tight">SETAN</span>
    </div>`;
  }

  const red = isRedSuit(card.suit);
  const colClass = red ? 'suit-red' : 'suit-black';
  return `
    <div class="playing-card card-front ${sizeCls} ${selectable ? 'selectable cursor-pointer' : ''} ${selected ? 'selected' : ''} ${extraClass} p-1 sm:p-1.5 flex flex-col justify-between" data-card-id="${card.id}">
      <div class="text-left font-extrabold leading-none ${colClass}">${card.rank}</div>
      <div class="text-center text-lg sm:text-2xl leading-none ${colClass}">${card.suit}</div>
      <div class="text-right font-extrabold leading-none ${colClass}">${card.rank}</div>
    </div>`;
}

function rankNum(rank) {
  return RANKS.indexOf(rank) + 1;
}

function isSevenUpPlayable(card, board) {
  if (!card || !board) return false;
  const lane = board[card.suit];
  const num = rankNum(card.rank);
  if (!lane) return num === 7;
  return num === lane.low - 1 || num === lane.high + 1;
}

// ==================== API HELPERS ====================
async function apiPost(endpoint, data = {}) {
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    return await res.json();
  } catch (err) {
    console.error(`API Error POST ${endpoint}:`, err);
    return { error: 'Gagal terhubung ke server!' };
  }
}

async function apiGet(endpoint) {
  try {
    const res = await fetch(endpoint);
    return await res.json();
  } catch (err) {
    console.error(`API Error GET ${endpoint}:`, err);
    return { error: 'Gagal terhubung ke server!' };
  }
}

// ==================== AUTH & PLAYER MANAGEMENT ====================
async function syncPlayerWithDB() {
  const res = await apiPost('/api/player/sync', app.player);
  if (res && res.ok && res.player) {
    applyPlayerProfile(res.player);
  }
}

function applyPlayerProfile(p) {
  app.player.id = p.id;
  app.player.name = p.name;
  app.player.username = p.username || null;
  app.player.avatar = p.avatar || '🦊';
  app.player.frame = p.frame || 'border-amber-400';
  app.player.skin = p.skin || 'skin-royal';
  app.player.tableSkin = p.table_skin || 'table-emerald';
  app.player.coins = p.coins !== undefined ? p.coins : 2500;
  app.player.highscore = p.highscore !== undefined ? p.highscore : p.coins;
  app.player.wins = p.wins || 0;
  app.player.matches = p.matches || 0;

  localStorage.setItem('carena_player_id', app.player.id);
  localStorage.setItem('carena_player_name', app.player.name);
  if (app.player.username) {
    localStorage.setItem('carena_player_username', app.player.username);
  } else {
    localStorage.removeItem('carena_player_username');
  }

  updatePlayerUI();
}

function updatePlayerUI() {
  const p = app.player;
  document.getElementById('input-player-name').value = p.name;
  document.getElementById('lobby-avatar-preview').textContent = p.avatar;
  document.getElementById('lobby-chips-count').textContent = Number(p.coins).toLocaleString('id-ID');
  document.getElementById('lobby-highscore-count').textContent = Number(p.highscore).toLocaleString('id-ID');
  document.getElementById('lobby-wins-count').textContent = p.wins;
  document.getElementById('lobby-matches-count').textContent = p.matches;

  const authLabel = document.getElementById('header-auth-label');
  const accountBadge = document.getElementById('lobby-account-badge');
  const btnLogout = document.getElementById('btn-logout');

  if (p.username) {
    authLabel.textContent = `@${p.username}`;
    accountBadge.textContent = `@${p.username} (Terdaftar)`;
    accountBadge.className = 'text-emerald-400 font-bold';
    btnLogout?.classList.remove('hidden');
  } else {
    authLabel.textContent = 'Masuk / Daftar';
    accountBadge.textContent = 'Tamu (Belum Login)';
    accountBadge.className = 'text-sky-300 font-bold';
    btnLogout?.classList.add('hidden');
  }

  const skinObj = CARD_SKINS.find(s => s.id === p.skin);
  if (skinObj) document.getElementById('lobby-skin-label').textContent = skinObj.name;
  const tableObj = TABLE_SKINS.find(t => t.id === p.tableSkin);
  if (tableObj) document.getElementById('lobby-table-label').textContent = tableObj.name;

  applyCosmetics();
}

async function renamePlayer(newName) {
  if (!newName || !newName.trim()) {
    showToast('Nama tidak boleh kosong!', 'warn');
    return;
  }
  const res = await apiPost('/api/player/rename', {
    id: app.player.id,
    name: newName.trim()
  });

  if (res.ok && res.player) {
    applyPlayerProfile(res.player);
    showToast(`Nama berhasil diubah menjadi "${res.player.name}"!`, 'success');
  } else {
    showToast(res.error || 'Gagal mengubah nama', 'error');
  }
}

async function loginPlayer(username, password) {
  const res = await apiPost('/api/auth/login', { username, password });
  if (res.ok && res.player) {
    applyPlayerProfile(res.player);
    document.getElementById('modal-auth').classList.add('hidden');
    showToast(`Selamat datang kembali, ${res.player.name}!`, 'success');
    return true;
  } else {
    const errBox = document.getElementById('login-error');
    errBox.textContent = res.error || 'Login gagal!';
    errBox.classList.remove('hidden');
    SFX.alert();
    return false;
  }
}

async function registerPlayer(username, password, name) {
  const res = await apiPost('/api/auth/register', {
    username,
    password,
    name: name || username,
    avatar: app.player.avatar,
    frame: app.player.frame
  });

  if (res.ok && res.player) {
    applyPlayerProfile(res.player);
    document.getElementById('modal-auth').classList.add('hidden');
    showToast(`Akun @${res.player.username} berhasil dibuat & masuk!`, 'success');
    return true;
  } else {
    const errBox = document.getElementById('reg-error');
    errBox.textContent = res.error || 'Pendaftaran gagal!';
    errBox.classList.remove('hidden');
    SFX.alert();
    return false;
  }
}

function logoutPlayer() {
  localStorage.removeItem('carena_player_username');
  app.player.username = null;
  app.player.id = 'usr_' + Math.floor(100000 + Math.random() * 900000);
  app.player.name = 'Pemain-' + Math.floor(100 + Math.random() * 900);
  app.player.coins = 2500;
  app.player.highscore = 2500;
  app.player.wins = 0;
  app.player.matches = 0;
  localStorage.setItem('carena_player_id', app.player.id);
  localStorage.setItem('carena_player_name', app.player.name);
  updatePlayerUI();
  document.getElementById('modal-auth').classList.add('hidden');
  showToast('Anda telah logout dan menggunakan mode Tamu.', 'info');
}

function applyCosmetics() {
  const body = document.getElementById('app-body');
  CARD_SKINS.forEach(s => body.classList.remove(s.id));
  TABLE_SKINS.forEach(t => body.classList.remove(t.id));
  body.classList.add(app.player.skin);
  body.classList.add(app.player.tableSkin);
}

// ==================== HEARTBEAT SYNC LOOP (100% RELIABLE PVP) ====================
let isSyncInProgress = false;

async function triggerImmediateGameSync() {
  if (app.view !== 'game' || !app.currentRoom) return;
  try {
    const res = await apiGet(`/api/game/${app.currentRoom.id}/sync?playerId=${app.player.id}&version=${app.gameVersion}&since=${app.lastEventId}`);
    if (res.ok && res.game) {
      if (!res.version || res.version >= app.gameVersion) {
        app.game = res.game;
        app.gameVersion = res.version || app.gameVersion;
        if (res.mySeat !== undefined && res.mySeat !== -1) {
          app.mySeat = res.mySeat;
        }
        renderGameTable();
      }
    }
  } catch (e) {}
}

function startHeartbeatSync() {
  if (app.syncTimer) clearInterval(app.syncTimer);

  app.syncTimer = setInterval(async () => {
    if (isSyncInProgress) return; // Prevent concurrent sync overlap
    isSyncInProgress = true;
    try {
      // 1. Lounge Sync
      if (app.view === 'lounge' && app.currentRoom) {
        const res = await apiGet(`/api/rooms/${app.currentRoom.id}/sync?since=${app.lastEventId}`);
        if (res.ok && res.room) {
          app.currentRoom = res.room;
          app.roomPlayers = res.players || [];
          renderLounge();

          // CRITICAL: If host started the game, other party switches IMMEDIATELY!
          if (res.room.status === 'playing') {
            SFX.card();
            showToast('Host telah memulai permainan! Memasuki meja...', 'success');
            switchToGameView();
            return;
          }

          if (res.latestEventId) app.lastEventId = res.latestEventId;
          if (res.events && res.events.length > 0) {
            for (const ev of res.events) {
              handleServerEvent(ev.event_type, ev.payload);
            }
          }
        }
      }

      // 2. Game Sync
      if (app.view === 'game' && app.currentRoom) {
        const res = await apiGet(`/api/game/${app.currentRoom.id}/sync?playerId=${app.player.id}&version=${app.gameVersion}&since=${app.lastEventId}`);
        if (res.ok && res.game) {
          // Strictly reject stale state overwrites
          if (!res.version || res.version >= app.gameVersion) {
            app.game = res.game;
            app.mySeat = res.mySeat;
            app.gameVersion = res.version || app.gameVersion;
            renderGameTable();
          }

          if (res.latestEventId) app.lastEventId = res.latestEventId;
          if (res.events && res.events.length > 0) {
            for (const ev of res.events) {
              handleServerEvent(ev.event_type, ev.payload);
            }
          }
        }
      }

      // 3. Lobby Auto-Refresh
      if (app.view === 'lobby') {
        refreshRoomsList();
      }
    } catch (e) {
      console.warn('Sync loop heartbeat error:', e);
    } finally {
      isSyncInProgress = false;
    }
  }, 1200); // Polls every 1.2s for silky-smooth sync
}

// ==================== SSE CONNECTION ====================
function connectRoomSSE(roomId) {
  if (app.sseSource) app.sseSource.close();
  try {
    app.sseSource = new EventSource(`/api/events/${roomId}`);
    app.sseSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.id && data.id > app.lastEventId) app.lastEventId = data.id;
        handleServerEvent(data.type, data.payload);
      } catch (e) {}
    };
  } catch (e) {}
}

function handleServerEvent(type, payload) {
  if (type === 'PLAYER_JOINED') {
    showToast(`${payload.name} bergabung ke kursi ${payload.seat + 1}!`, 'info');
  } else if (type === 'PLAYER_LEFT') {
    showToast('Seorang pemain keluar dari ruangan.', 'info');
  } else if (type === 'GAME_START') {
    SFX.card();
    showToast('Permainan dimulai!', 'success');
    switchToGameView();
  } else if (type === 'GAME_UPDATE') {
    SFX.card();
    triggerImmediateGameSync();
  } else if (type === 'ROOM_DELETED') {
    SFX.alert();
    showToast(payload.reason || 'Ruangan telah dihapus', 'warn');
    if (app.sseSource) app.sseSource.close();
    app.currentRoom = null;
    app.game = null;
    switchView('lobby');
    refreshRoomsList();
  } else if (type === 'GAME_OVER') {
    SFX.win();
    showToast(payload.winnerText, 'success');
    syncPlayerWithDB();
  } else if (type === 'CHAT') {
    addChatMessage(payload.sender, payload.avatar, payload.message);
    if (payload.seat !== undefined && payload.seat !== null) {
      triggerSpeechBubble(payload.seat, payload.message);
    }
  } else if (type === 'EMOTE') {
    triggerSeatEmote(payload.seat, payload.emote);
  }
}

// ==================== ROOM & LOBBY LOGIC ====================
async function refreshRoomsList() {
  const container = document.getElementById('rooms-list');
  const res = await apiGet('/api/rooms');
  if (!res.ok || !res.rooms) return;

  if (res.rooms.length === 0) {
    container.innerHTML = `
      <div class="col-span-full py-6 text-center text-slate-400 text-xs space-y-2">
        <p>Belum ada ruangan aktif saat ini.</p>
        <button id="btn-empty-create" class="px-3.5 py-1.5 bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold border-2 border-black">
          ➕ Buat Ruangan Pertama
        </button>
      </div>`;
    document.getElementById('btn-empty-create')?.addEventListener('click', () => {
      document.getElementById('modal-create-room').classList.remove('hidden');
    });
    return;
  }

  container.innerHTML = res.rooms.map(r => {
    const mode = GAME_MODES.find(m => m.id === r.mode) || { name: r.mode, icon: '🃏' };
    const isPlaying = r.status === 'playing';
    return `
      <div class="bg-slate-950/85 border-2 border-slate-700 hover:border-amber-400/80 p-3 flex flex-col justify-between gap-2.5 transition">
        <div class="flex items-start justify-between gap-2">
          <div>
            <div class="flex items-center gap-1.5 flex-wrap">
              <span class="text-xs font-bold text-white">${escapeHtml(r.name)}</span>
              <span class="px-1.5 py-0.2 bg-slate-800 text-amber-300 border border-slate-700 text-[10px] font-mono">#${r.code}</span>
              ${r.is_private ? '<span class="text-xs" title="Ruangan Private">🔒</span>' : ''}
            </div>
            <div class="text-[11px] text-slate-400 mt-1 flex items-center gap-1.5">
              <span>${mode.icon} <strong class="text-emerald-300">${mode.name}</strong></span>
              <span>·</span>
              <span>Host: <strong class="text-amber-200">${escapeHtml(r.host_name)}</strong></span>
            </div>
          </div>
          <span class="px-2 py-0.5 ${isPlaying ? 'bg-indigo-500/20 text-indigo-300 border-indigo-500/40' : 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40'} border text-[10px] font-bold shrink-0">
            ${isPlaying ? 'Sedang Main' : 'Menunggu'}
          </span>
        </div>

        <div class="flex items-center justify-between pt-2 border-t border-slate-800/80">
          <span class="text-xs text-slate-300 font-medium">
            👥 <strong>${r.current_players}</strong> / ${r.max_players} Kursi
          </span>
          <button data-join-room-id="${r.id}" data-is-private="${r.is_private}" class="px-3 py-1 bg-amber-400 hover:bg-amber-300 text-slate-950 font-bold text-xs border-2 border-black">
            ${isPlaying ? 'Masuk Meja' : 'Gabung'}
          </button>
        </div>
      </div>`;
  }).join('');

  container.querySelectorAll('[data-join-room-id]').forEach(btn => {
    btn.addEventListener('click', () => {
      const roomId = btn.dataset.joinRoomId;
      const isPriv = btn.dataset.isPrivate === 'true';
      if (isPriv) {
        app.pendingJoinRoom = { id: roomId };
        document.getElementById('jp-input').value = '';
        document.getElementById('jp-error').classList.add('hidden');
        document.getElementById('modal-join-password').classList.remove('hidden');
      } else {
        joinRoom(roomId);
      }
    });
  });
}

async function joinRoom(roomIdent, password = '') {
  showToast('Menghubungkan ke ruangan...', 'info');
  const res = await apiPost(`/api/rooms/${roomIdent}/join`, {
    playerId: app.player.id,
    password
  });

  if (!res.ok) {
    SFX.alert();
    showToast(res.error || 'Gagal masuk ke ruangan!', 'error');
    return false;
  }

  app.currentRoom = res.room;
  app.mySeat = res.seat;
  app.lastEventId = 0;
  connectRoomSSE(res.room.id);

  if (res.room.status === 'playing') {
    switchToGameView();
  } else {
    switchToLoungeView();
  }
  return true;
}

function renderLounge() {
  const r = app.currentRoom;
  if (!r) return;

  const mode = GAME_MODES.find(m => m.id === r.mode) || { name: r.mode, icon: '🃏' };
  document.getElementById('lounge-mode-icon').textContent = mode.icon;
  document.getElementById('lounge-room-name').textContent = r.name;
  document.getElementById('lounge-mode-title').textContent = mode.name;
  document.getElementById('lounge-code-badge').textContent = '#' + r.code;
  document.getElementById('lounge-max-count').textContent = r.max_players;

  const hostPlayer = app.roomPlayers.find(p => p.is_host);
  if (hostPlayer) {
    document.getElementById('lounge-host-name').textContent = hostPlayer.name;
  }

  const isMeHost = hostPlayer && hostPlayer.id === app.player.id;
  document.getElementById('btn-lounge-start').classList.toggle('hidden', !isMeHost);
  document.getElementById('btn-lounge-fill-bots').classList.toggle('hidden', !isMeHost);

  // Render Seats
  const grid = document.getElementById('lounge-seats-grid');
  document.getElementById('lounge-seated-count').textContent = app.roomPlayers.length;

  const seatItems = [];
  for (let s = 0; s < r.max_players; s++) {
    const pl = app.roomPlayers.find(p => p.seat === s);
    if (pl) {
      const isMe = pl.id === app.player.id;
      seatItems.push(`
        <div class="bg-slate-950 border-2 ${isMe ? 'border-amber-400 ring-2 ring-amber-400/30' : 'border-slate-700'} p-3 flex flex-col items-center text-center gap-1.5 relative">
          ${pl.is_host ? '<span class="absolute top-1 left-1 text-sm" title="Host">👑</span>' : ''}
          <div class="w-12 h-12 bg-slate-800 border-2 ${pl.frame || 'border-amber-400'} flex items-center justify-center text-2xl shadow">
            ${pl.avatar || '🦊'}
          </div>
          <div class="text-xs font-bold text-white truncate max-w-full">${escapeHtml(pl.name)}</div>
          <span class="px-2 py-0.5 text-[10px] font-bold ${pl.is_ready ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40' : 'bg-slate-800 text-slate-400'}">
            ${pl.is_ready ? '✅ SIAP' : 'Menunggu'}
          </span>
        </div>`);
    } else {
      seatItems.push(`
        <div class="bg-slate-950/40 border-2 border-dashed border-slate-800 p-3 flex flex-col items-center justify-center text-center min-h-[110px]">
          <span class="text-xl opacity-30">🪑</span>
          <span class="text-[11px] text-slate-500 font-bold mt-1">Kursi ${s + 1} Kosong</span>
        </div>`);
    }
  }
  grid.innerHTML = seatItems.join('');
}

// ==================== VIEW SWITCHING ====================
function switchView(viewName) {
  app.view = viewName;
  document.getElementById('view-lobby').classList.toggle('hidden', viewName !== 'lobby');
  document.getElementById('view-lounge').classList.toggle('hidden', viewName !== 'lounge');
  document.getElementById('view-game').classList.toggle('hidden', viewName !== 'game');
  document.getElementById('btn-back-lobby').classList.toggle('hidden', viewName === 'lobby');

  const badge = document.getElementById('header-mode-badge');
  if (viewName === 'lobby') {
    badge.textContent = 'Lobby';
    badge.className = 'inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold bg-emerald-500/20 text-emerald-300 border border-emerald-500/30';
  } else if (viewName === 'lounge') {
    badge.textContent = 'Ruang Tunggu';
    badge.className = 'inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold bg-sky-500/20 text-sky-300 border border-sky-500/30';
  } else if (viewName === 'game') {
    badge.textContent = 'Meja Bertanding';
    badge.className = 'inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold bg-amber-500/20 text-amber-300 border border-amber-500/30';
  }
}

function switchToLoungeView() {
  switchView('lounge');
  renderLounge();
}

async function switchToGameView() {
  switchView('game');
  if (app.currentRoom) {
    const res = await apiGet(`/api/game/${app.currentRoom.id}?playerId=${app.player.id}`);
    if (res.ok && res.game) {
      app.game = res.game;
      app.mySeat = res.mySeat;
      renderGameTable();
    }
  }
}

// ==================== IN-GAME TABLE RENDERING ====================
function renderGameTable() {
  const g = app.game;
  if (!g) return;

  const mode = GAME_MODES.find(m => m.id === g.mode) || { name: g.mode, icon: '🃏' };
  document.getElementById('game-mode-icon').textContent = mode.icon;
  document.getElementById('game-mode-title').textContent = mode.name;
  document.getElementById('game-status-text').textContent = g.status;

  // 1. Resolve My Player Index strictly by playerId (Prevents seat mismatch / desync)
  let myIdx = -1;
  if (g.players) {
    myIdx = g.players.findIndex(p => p.playerId === app.player.id);
  }
  if (myIdx === -1 && app.mySeat >= 0 && app.mySeat < (g.players ? g.players.length : 0)) {
    myIdx = app.mySeat;
  }
  app.mySeat = myIdx;

  // Turn Timer calculation (60s max per turn)
  const elapsedSec = Math.floor((Date.now() - (g.turnStartedAt || Date.now())) / 1000);
  const remainingSec = Math.max(0, (g.turnTimeLimitSec || 60) - elapsedSec);
  const timerBadgeEl = document.getElementById('game-turn-timer-text');
  if (timerBadgeEl) {
    timerBadgeEl.textContent = `${remainingSec}s`;
    const parent = timerBadgeEl.parentElement;
    if (parent) {
      parent.classList.toggle('border-rose-500', remainingSec <= 10);
      parent.classList.toggle('text-rose-400', remainingSec <= 10);
      parent.classList.toggle('border-amber-400', remainingSec > 10);
      parent.classList.toggle('text-amber-300', remainingSec > 10);
    }
  }

  // 2. Render Opponents
  const oppBox = document.getElementById('opponents-container');
  const opps = g.players.filter((p, idx) => idx !== myIdx);

  oppBox.innerHTML = opps.map(p => {
    const isTurn = !g.finished && g.turn === p.id;
    let subText = `${p.handCount !== undefined ? p.handCount : p.hand.length} Kartu`;
    if (g.mode === 'gofish') subText = `${p.handCount} Krt · ${p.books || 0} Book`;
    else if (g.mode === 'minuman') subText = `${p.score || 0} Tantangan`;
    else if (g.mode === 'blackjack') subText = p.status || `Total: ?`;

    const isGoFishTarget = g.mode === 'gofish' && g.targetPlayerIdx === p.id;
    const clickCls = g.mode === 'gofish' ? 'cursor-pointer hover:border-amber-400' : '';
    const turnBadge = isTurn ? `<span class="px-1 py-0.5 bg-amber-400 text-slate-950 text-[9px] font-mono font-extrabold ml-1">⏱️ ${remainingSec}s</span>` : '';
    return `
      <div data-opp-seat="${p.id}" class="relative bg-slate-950/85 border-2 ${isGoFishTarget ? 'border-amber-400 ring-2 ring-amber-400/50' : 'border-slate-700'} ${isTurn ? 'active-turn-seat ring-2 ring-amber-400' : ''} ${clickCls} px-2.5 py-1.5 flex items-center gap-2 min-w-[112px] transition">
        <div class="w-8 h-8 bg-slate-800 border-2 ${p.frame || 'border-amber-400'} flex items-center justify-center text-base shrink-0">${p.avatar}</div>
        <div class="leading-tight min-w-0">
          <div class="text-[11px] font-bold text-white truncate flex items-center">${escapeHtml(p.name)} ${turnBadge}</div>
          <div class="text-[10px] text-amber-300 font-medium">${subText}</div>
        </div>
        <div id="emote-anchor-${p.id}" class="absolute -top-4 left-1/2"></div>
        <div id="speech-anchor-${p.id}" class="absolute -top-8 left-1/2"></div>
      </div>`;
  }).join('');

  if (g.mode === 'gofish') {
    oppBox.querySelectorAll('[data-opp-seat]').forEach(el => {
      el.addEventListener('click', () => {
        g.targetPlayerIdx = Number(el.dataset.oppSeat);
        renderGameTable();
      });
    });
  }

  // 3. Render My Seat Info
  const me = (myIdx >= 0 && g.players[myIdx]) ? g.players[myIdx] : { name: app.player.name, avatar: app.player.avatar, hand: [] };
  document.getElementById('my-seat-avatar').textContent = me.avatar || app.player.avatar;
  document.getElementById('my-seat-name').textContent = me.name;
  const isMyTurn = !g.finished && g.turn === myIdx;
  document.getElementById('my-turn-pill').classList.toggle('hidden', !isMyTurn);
  const myTurnTimer = document.getElementById('my-turn-timer');
  if (myTurnTimer) {
    myTurnTimer.classList.toggle('hidden', !isMyTurn);
    myTurnTimer.textContent = `⏱️ ${remainingSec}s`;
    myTurnTimer.className = remainingSec <= 10
      ? 'px-1.5 py-0.5 bg-rose-600 text-white text-[10px] font-mono font-extrabold animate-pulse'
      : 'px-1.5 py-0.5 bg-amber-500 text-slate-950 text-[10px] font-mono font-extrabold';
  }
  document.getElementById('my-seat-badge').classList.toggle('active-turn-seat', isMyTurn);

  let mySub = `${me.hand ? me.hand.length : 0} Kartu`;
  if (g.mode === 'gofish') mySub = `${me.hand.length} Kartu · ${me.books || 0} Book`;
  else if (g.mode === 'minuman') mySub = `${me.score || 0} Tantangan`;
  document.getElementById('my-seat-sub').textContent = mySub;

  // 4. Render Center Table & Actions
  const center = document.getElementById('table-center');
  const actions = document.getElementById('action-bar');

  if (g.finished) {
    center.innerHTML = `
      <div class="bg-slate-950/90 border-4 border-amber-400 px-6 py-4 max-w-md shadow-2xl space-y-2">
        <div class="text-2xl">🏆</div>
        <div class="text-sm sm:text-base font-extrabold text-amber-300">${escapeHtml(g.winnerText)}</div>
        <button id="btn-center-rematch" class="mt-2 px-4 py-2 bg-amber-400 hover:bg-amber-300 text-slate-950 font-extrabold text-xs border-2 border-black">
          Mulai Ronde Baru
        </button>
      </div>`;
    actions.innerHTML = '';
    document.getElementById('btn-center-rematch')?.addEventListener('click', () => {
      apiPost(`/api/rooms/${app.currentRoom.id}/start`, { hostId: app.player.id });
    });
  } else if (g.mode === 'capsa') {
    center.innerHTML = g.tablePlay
      ? `<div class="text-[11px] font-semibold text-emerald-200 mb-1">${escapeHtml(g.players[g.tablePlay.by].name)} · <span class="text-amber-300 font-bold">${escapeHtml(g.tablePlay.label || '')}</span></div>
         <div class="flex items-center justify-center gap-1.5 flex-wrap">${g.tablePlay.cards.map(c => cardHTML(c)).join('')}</div>`
      : `<div class="px-4 py-3 bg-black/35 border-2 border-amber-400/50 text-xs text-emerald-100">${g.mustInclude3D ? 'Pembuka wajib menyertakan <strong class="text-amber-300">3♦ (3 Wajik)</strong>!' : 'Meja kosong — keluarkan kombinasi kartu bebas!'}</div>`;
    
    actions.innerHTML = isMyTurn ? `
      <button id="act-capsa-play" class="px-3.5 py-1.5 bg-amber-400 hover:bg-amber-300 text-slate-950 font-bold text-xs border-2 border-black">Keluarkan (${app.selectedCardIds.size})</button>
      <button id="act-capsa-pass" class="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 font-bold text-xs border-2 border-black">Pass</button>
    ` : `<span class="text-xs text-emerald-200/80 font-medium">Menunggu giliran ${g.players[g.turn].name}...</span>`;

    document.getElementById('act-capsa-play')?.addEventListener('click', () => {
      submitGameAction('play', { cardIds: Array.from(app.selectedCardIds) });
    });
    document.getElementById('act-capsa-pass')?.addEventListener('click', () => {
      submitGameAction('pass');
    });
  } else if (g.mode === 'setan') {
    let prevIdx = -1;
    for (let step = 1; step < g.players.length; step++) {
      const idx = (myIdx - step + g.players.length) % g.players.length;
      if (g.players[idx].handCount > 0 || (g.players[idx].hand && g.players[idx].hand.length > 0)) {
        prevIdx = idx;
        break;
      }
    }
    const target = prevIdx !== -1 ? g.players[prevIdx] : null;
    const targetCardsCount = target ? (target.handCount !== undefined ? target.handCount : target.hand.length) : 0;

    center.innerHTML = `
      <div class="text-xs text-emerald-100 font-semibold">${escapeHtml(g.lastActionText || '')}</div>
      ${isMyTurn && target ? `
        <div class="mt-1 text-[11px] text-amber-300 font-bold">Klik salah satu kartu milik ${escapeHtml(target.name)} untuk dicabut:</div>
        <div class="flex items-center justify-center gap-1.5 flex-wrap mt-1">
          ${Array.from({ length: targetCardsCount }).map((_, idx) => `<div data-pick-setan="${idx}">${cardHTML(null, { small: true, faceDown: true, selectable: true })}</div>`).join('')}
        </div>` : `<div class="mt-2 flex items-center gap-2">${cardHTML(null, { small: true, faceDown: true })}</div>`}`;

    actions.innerHTML = isMyTurn ? `<span class="text-xs font-bold text-amber-300">Cabut 1 kartu lawan di atas ↑</span>` : '';
    center.querySelectorAll('[data-pick-setan]').forEach(el => {
      el.addEventListener('click', () => {
        submitGameAction('draw', { cardIndex: Number(el.dataset.pickSetan) });
      });
    });
  } else if (g.mode === 'sevenup') {
    center.innerHTML = `
      <div class="grid grid-cols-2 sm:grid-cols-4 gap-2 w-full max-w-xl">
        ${SUITS.map(s => {
          const lane = g.board[s];
          const colorCls = isRedSuit(s) ? 'text-rose-400' : 'text-slate-100';
          return `<div class="bg-black/35 border-2 border-white/20 p-2 text-center">
            <div class="text-lg ${colorCls} font-bold">${s}</div>
            <div class="text-xs font-extrabold text-amber-300 mt-0.5">${lane ? `${RANKS[lane.low - 1]} — ${RANKS[lane.high - 1]}` : 'Belum ada 7'}</div>
          </div>`;
        }).join('')}
      </div>`;
    actions.innerHTML = isMyTurn ? `
      <button id="act-7up-pass" class="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 font-bold text-xs border-2 border-black">Pass (Tidak Ada Kartu)</button>
    ` : `<span class="text-xs text-emerald-200/80">Menunggu ${g.players[g.turn].name}...</span>`;
    document.getElementById('act-7up-pass')?.addEventListener('click', () => submitGameAction('pass'));
  } else if (g.mode === 'gofish') {
    const myRanks = [...new Set(me.hand.map(c => c.rank))];
    const target = g.players[g.targetPlayerIdx] || opps[0] || g.players[1];
    center.innerHTML = `
      <div class="text-xs font-semibold text-emerald-100 max-w-md">${escapeHtml(g.lastFishLog || '')}</div>
      <div class="text-[11px] text-amber-300">Target Lawan: <strong>${escapeHtml(target.name)}</strong> (klik kursi lawan untuk ganti)</div>
      ${isMyTurn && myRanks.length ? `
        <div class="flex flex-wrap items-center justify-center gap-1.5 mt-1">
          ${myRanks.map(r => `<button data-fish-rank="${r}" class="px-2.5 py-1 text-xs font-bold border-2 ${g.selectedRank === r ? 'bg-amber-400 text-slate-950 border-black' : 'bg-slate-900/80 text-white border-slate-600'}">${r}</button>`).join('')}
        </div>` : ''}`;
    actions.innerHTML = isMyTurn ? `
      <button id="act-fish-ask" class="px-3.5 py-1.5 bg-amber-400 hover:bg-amber-300 text-slate-950 font-bold text-xs border-2 border-black">Minta ${g.selectedRank || myRanks[0]} ke ${escapeHtml(target.name)}</button>
    ` : `<span class="text-xs text-emerald-200/80">Menunggu ${g.players[g.turn].name}...</span>`;
    center.querySelectorAll('[data-fish-rank]').forEach(b => {
      b.addEventListener('click', () => { g.selectedRank = b.dataset.fishRank; renderGameTable(); });
    });
    document.getElementById('act-fish-ask')?.addEventListener('click', () => {
      submitGameAction('ask', { targetIdx: target.id, rank: g.selectedRank || myRanks[0] });
    });
  } else if (g.mode === 'bohong') {
    const targetRank = RANKS[g.targetRankIdx];
    center.innerHTML = `
      <div class="flex items-center gap-3">
        ${cardHTML(null, { faceDown: true })}
        <div class="text-left space-y-1">
          <div class="text-xs font-bold text-amber-300">Target Angka: <span class="px-2 py-0.5 bg-amber-400 text-slate-950">${targetRank}</span></div>
          <div class="text-xs text-emerald-100">Tumpukan Meja: <strong>${g.pile ? g.pile.length : 0} kartu</strong></div>
        </div>
      </div>`;
    actions.innerHTML = `
      ${g.lastClaim && g.lastClaim.by !== myIdx ? `<button id="act-call-bluff" class="px-3 py-1.5 bg-rose-500 hover:bg-rose-400 text-white font-bold text-xs border-2 border-black">🚨 Tuduh Bohong!</button>` : ''}
      ${isMyTurn ? `<button id="act-bohong-play" class="px-3.5 py-1.5 bg-amber-400 hover:bg-amber-300 text-slate-950 font-bold text-xs border-2 border-black">Taruh Tertutup (${app.selectedCardIds.size})</button>` : ''}
    `;
    document.getElementById('act-call-bluff')?.addEventListener('click', () => submitGameAction('call_bluff'));
    document.getElementById('act-bohong-play')?.addEventListener('click', () => {
      submitGameAction('play', { cardIds: Array.from(app.selectedCardIds) });
    });
  } else if (g.mode === 'empatsatu') {
    const topDiscard = g.discard ? g.discard[g.discard.length - 1] : null;
    center.innerHTML = `
      <div class="flex items-center justify-center gap-5">
        <div class="flex flex-col items-center gap-1">
          <div id="act-41-deck" class="${isMyTurn && g.phase === 'draw' ? 'cursor-pointer ring-2 ring-amber-400' : ''}">${cardHTML(null, { faceDown: true, selectable: isMyTurn && g.phase === 'draw' })}</div>
          <span class="text-[11px] font-bold text-emerald-100">Dek</span>
        </div>
        <div class="flex flex-col items-center gap-1">
          <div id="act-41-discard" class="${isMyTurn && g.phase === 'draw' ? 'cursor-pointer ring-2 ring-amber-400' : ''}">${topDiscard ? cardHTML(topDiscard, { selectable: isMyTurn && g.phase === 'draw' }) : ''}</div>
          <span class="text-[11px] font-bold text-amber-300">Buangan</span>
        </div>
      </div>`;
    actions.innerHTML = isMyTurn ? `
      ${g.phase === 'draw' ? `<button id="act-41-knock" class="px-3.5 py-1.5 bg-amber-400 hover:bg-amber-300 text-slate-950 font-bold text-xs border-2 border-black">Tutup Meja (41!)</button>` : '<span class="text-xs font-bold text-amber-300">Klik 1 kartu di tanganmu untuk dibuang ↓</span>'}
    ` : `<span class="text-xs text-emerald-200/80">Giliran ${g.players[g.turn].name}...</span>`;
    document.getElementById('act-41-deck')?.addEventListener('click', () => {
      if (isMyTurn && g.phase === 'draw') submitGameAction('draw', { source: 'deck' });
    });
    document.getElementById('act-41-discard')?.addEventListener('click', () => {
      if (isMyTurn && g.phase === 'draw') submitGameAction('draw', { source: 'discard' });
    });
    document.getElementById('act-41-knock')?.addEventListener('click', () => submitGameAction('knock'));
  } else if (g.mode === 'minuman') {
    center.innerHTML = `
      <div class="flex items-center gap-4">
        ${cardHTML(null, { faceDown: true })}
        <div class="bg-slate-950/85 border-2 border-amber-400 p-3 text-left max-w-xs">
          <div class="text-xs font-extrabold text-amber-300">${g.currentRule ? g.currentRule.title : 'Lingkaran Party Siap! 🍻'}</div>
          <p class="text-[11px] text-slate-200 mt-1 leading-relaxed">${g.currentRule ? g.currentRule.text : 'Tarik kartu saat giliranmu untuk membuka tantangan seru!'}</p>
        </div>
      </div>`;
    actions.innerHTML = isMyTurn ? `
      <button id="act-minuman-draw" class="px-4 py-2 bg-amber-400 hover:bg-amber-300 text-slate-950 font-extrabold text-xs border-2 border-black">🍻 Tarik Kartu</button>
    ` : `<span class="text-xs text-emerald-200/80">Giliran ${g.players[g.turn].name}...</span>`;
    document.getElementById('act-minuman-draw')?.addEventListener('click', () => submitGameAction('draw'));
  } else if (g.mode === 'blackjack') {
    center.innerHTML = `
      <div class="space-y-1.5">
        <div class="text-xs font-bold text-amber-300">BANDAR</div>
        <div class="flex items-center justify-center gap-1.5">
          ${g.dealer.hand.map(c => c.hidden ? cardHTML(null, { faceDown: true }) : cardHTML(c)).join('')}
        </div>
      </div>`;
    actions.innerHTML = isMyTurn ? `
      <button id="act-bj-hit" class="px-3.5 py-1.5 bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold text-xs border-2 border-black">Hit (+Kartu)</button>
      <button id="act-bj-stand" class="px-3.5 py-1.5 bg-amber-400 hover:bg-amber-300 text-slate-950 font-bold text-xs border-2 border-black">Stand</button>
      <button id="act-bj-double" class="px-3 py-1.5 bg-indigo-500 hover:bg-indigo-400 text-white font-bold text-xs border-2 border-black">Double (2x)</button>
    ` : `<span class="text-xs text-emerald-200/80">Giliran ${g.players[g.turn].name}...</span>`;
    document.getElementById('act-bj-hit')?.addEventListener('click', () => submitGameAction('hit'));
    document.getElementById('act-bj-stand')?.addEventListener('click', () => submitGameAction('stand'));
    document.getElementById('act-bj-double')?.addEventListener('click', () => submitGameAction('double'));
  }

  // 4. Render Player Hand
  const handBox = document.getElementById('player-hand');
  if (g.mode === 'minuman') {
    handBox.innerHTML = `<div class="text-xs text-slate-400 py-5">Mode Minuman menggunakan lingkaran bersama di tengah meja 🍻</div>`;
  } else if (!me.hand || me.hand.length === 0) {
    handBox.innerHTML = `<div class="text-xs text-emerald-400 font-bold py-5">Kartumu habis!</div>`;
  } else {
    handBox.innerHTML = me.hand.map(c => {
      const selectable = !g.finished && isMyTurn && (
        g.mode === 'capsa' || g.mode === 'bohong' ||
        (g.mode === 'sevenup' && isSevenUpPlayable(c, g.board)) ||
        (g.mode === 'empatsatu' && g.phase === 'discard')
      );
      const selected = app.selectedCardIds.has(c.id);
      const dim = (g.mode === 'sevenup' && isMyTurn && !isSevenUpPlayable(c, g.board)) ? 'opacity-45' : '';
      return cardHTML(c, { selectable, selected, extraClass: dim });
    }).join('');

    handBox.querySelectorAll('[data-card-id]').forEach(el => {
      el.addEventListener('click', () => {
        if (g.finished || !isMyTurn) return;
        const id = el.dataset.cardId;
        if (g.mode === 'capsa' || g.mode === 'bohong') {
          if (app.selectedCardIds.has(id)) app.selectedCardIds.delete(id);
          else app.selectedCardIds.add(id);
          SFX.card();
          renderGameTable();
        } else if (g.mode === 'sevenup') {
          submitGameAction('play', { cardId: id });
        } else if (g.mode === 'empatsatu' && g.phase === 'discard') {
          submitGameAction('discard', { cardId: id });
        }
      });
    });
  }
}

async function submitGameAction(action, payload = {}) {
  if (!app.currentRoom) return;
  const res = await apiPost(`/api/game/${app.currentRoom.id}/action`, {
    playerId: app.player.id,
    action,
    payload
  });

  if (!res.ok) {
    SFX.alert();
    showToast(res.error || 'Aksi kartu tidak valid!', 'error');
    return;
  }

  app.selectedCardIds.clear();
  app.game = res.game;
  if (res.version) app.gameVersion = res.version;
  if (res.mySeat !== undefined && res.mySeat !== -1) app.mySeat = res.mySeat;
  renderGameTable();
}

async function deleteCurrentRoom() {
  if (!app.currentRoom) return;
  const ok = confirm('Yakin ingin membubarkan/menghapus ruangan ini?');
  if (!ok) return;

  const res = await apiPost(`/api/rooms/${app.currentRoom.id}/delete`, {
    playerId: app.player.id
  });

  if (res.ok) {
    showToast('Ruangan berhasil dihapus / dibubarkan', 'info');
    if (app.sseSource) app.sseSource.close();
    app.currentRoom = null;
    app.game = null;
    switchView('lobby');
    refreshRoomsList();
  } else {
    showToast(res.error || 'Gagal menghapus ruangan', 'error');
  }
}

function startTurnCountdownTicker() {
  if (app.tickerInterval) clearInterval(app.tickerInterval);
  app.tickerInterval = setInterval(() => {
    if (app.view !== 'game' || !app.game || app.game.finished) return;

    const g = app.game;
    const elapsedSec = Math.floor((Date.now() - (g.turnStartedAt || Date.now())) / 1000);
    const limit = g.turnTimeLimitSec || 60;
    const remainingSec = Math.max(0, limit - elapsedSec);

    const timerBadgeEl = document.getElementById('game-turn-timer-text');
    if (timerBadgeEl) {
      timerBadgeEl.textContent = `${remainingSec}s`;
      const parent = timerBadgeEl.parentElement;
      if (parent) {
        parent.classList.toggle('border-rose-500', remainingSec <= 10);
        parent.classList.toggle('text-rose-400', remainingSec <= 10);
        parent.classList.toggle('border-amber-400', remainingSec > 10);
        parent.classList.toggle('text-amber-300', remainingSec > 10);
      }
    }

    const myIdx = g.players.findIndex(p => p.playerId === app.player.id);
    const isMyTurn = !g.finished && g.turn === myIdx;
    const myTurnTimer = document.getElementById('my-turn-timer');
    if (myTurnTimer) {
      myTurnTimer.classList.toggle('hidden', !isMyTurn);
      myTurnTimer.textContent = `⏱️ ${remainingSec}s`;
      myTurnTimer.className = remainingSec <= 10
        ? 'px-1.5 py-0.5 bg-rose-600 text-white text-[10px] font-mono font-extrabold animate-pulse'
        : 'px-1.5 py-0.5 bg-amber-500 text-slate-950 text-[10px] font-mono font-extrabold';
    }

    // If time ran out, trigger sync so server executes auto pass/action
    if (remainingSec === 0 && !app.isTimeoutSyncing) {
      app.isTimeoutSyncing = true;
      triggerImmediateGameSync().finally(() => {
        setTimeout(() => { app.isTimeoutSyncing = false; }, 2000);
      });
    }
  }, 1000);
}

// ==================== EMOTE & CHAT (SPEECH BUBBLES) ====================
function triggerSeatEmote(seatIdx, emote) {
  SFX.emote();
  const anchor = seatIdx === app.mySeat
    ? document.getElementById('my-emote-anchor')
    : document.getElementById(`emote-anchor-${seatIdx}`);

  if (!anchor) return;
  const bub = document.createElement('div');
  bub.className = 'emote-bubble absolute text-3xl z-40';
  bub.textContent = emote;
  anchor.appendChild(bub);
  setTimeout(() => bub.remove(), 2400);
}

function triggerSpeechBubble(seatIdx, text) {
  SFX.chat();
  const anchor = seatIdx === app.mySeat
    ? document.getElementById('my-speech-anchor')
    : document.getElementById(`speech-anchor-${seatIdx}`);

  if (!anchor) return;
  const bubble = document.createElement('div');
  bubble.className = 'speech-bubble';
  bubble.textContent = text;
  anchor.appendChild(bubble);
  setTimeout(() => bubble.remove(), 4500);
}

function sendChatMessage(msg) {
  if (!app.currentRoom || !msg || !msg.trim()) return;
  apiPost(`/api/events/${app.currentRoom.id}/chat`, {
    playerId: app.player.id,
    message: msg.trim()
  });
  triggerSpeechBubble(app.mySeat, msg.trim());
}

function sendEmote(emote) {
  if (!app.currentRoom) return;
  apiPost(`/api/events/${app.currentRoom.id}/emote`, {
    playerId: app.player.id,
    seat: app.mySeat,
    emote
  });
}

function addChatMessage(sender, avatar, text) {
  const container = document.getElementById('chat-messages');
  const msg = document.createElement('div');
  msg.className = 'bg-slate-950 border border-slate-800 p-2 flex items-start gap-2';
  msg.innerHTML = `
    <span class="text-base">${avatar || '🦊'}</span>
    <div class="leading-tight min-w-0">
      <div class="text-[11px] font-bold text-amber-300 truncate">${escapeHtml(sender)}</div>
      <div class="text-[11px] text-slate-200 break-words mt-0.5">${escapeHtml(text)}</div>
    </div>`;
  container.appendChild(msg);
  container.scrollTop = container.scrollHeight;

  if (!app.chatOpen) {
    app.unreadChat++;
    const badge = document.getElementById('chat-unread-badge');
    badge.textContent = app.unreadChat;
    badge.classList.remove('hidden');
  }
}

// ==================== LEADERBOARD / HIGHSCORE MODAL ====================
async function showLeaderboard() {
  const list = document.getElementById('leaderboard-list');
  list.innerHTML = '<div class="py-4 text-center text-slate-400">Memuat peringkat dari server Neon...</div>';
  document.getElementById('modal-leaderboard').classList.remove('hidden');

  const res = await apiGet('/api/leaderboard');
  if (!res.ok || !res.leaderboard) {
    list.innerHTML = '<div class="py-4 text-center text-rose-400">Gagal memuat papan peringkat.</div>';
    return;
  }

  list.innerHTML = res.leaderboard.map((p, idx) => {
    const medal = idx === 0 ? '🥇' : idx === 1 ? '🥈' : idx === 2 ? '🥉' : `#${idx + 1}`;
    const userTag = p.username ? `<span class="text-[10px] text-sky-400 font-normal">@${escapeHtml(p.username)}</span>` : '';
    return `
      <div class="bg-slate-950 border border-slate-800 p-2.5 flex items-center justify-between gap-3">
        <div class="flex items-center gap-2.5 min-w-0">
          <span class="pixel-font text-xs text-amber-300 w-7 text-center shrink-0">${medal}</span>
          <div class="w-8 h-8 bg-slate-800 border-2 ${p.frame || 'border-amber-400'} flex items-center justify-center text-base shrink-0">${p.avatar || '🦊'}</div>
          <div class="truncate">
            <div class="font-bold text-white text-xs truncate flex items-center gap-1.5">
              <span>${escapeHtml(p.name)}</span>
              ${userTag}
            </div>
            <div class="text-[10px] text-slate-400">${p.wins || 0} Menang · ${p.matches || 0} Pertandingan</div>
          </div>
        </div>
        <div class="text-right shrink-0">
          <div class="text-xs font-bold text-yellow-300">🏆 ${Number(p.highscore || p.coins || 0).toLocaleString('id-ID')}</div>
          <div class="text-[10px] text-slate-400">${Number(p.coins || 0).toLocaleString('id-ID')} Koin</div>
        </div>
      </div>`;
  }).join('');
}

// ==================== CUSTOMIZATION MODAL ====================
function renderCustomizeModal() {
  // Skins
  document.getElementById('skins-grid').innerHTML = CARD_SKINS.map(s => `
    <div data-skin-id="${s.id}" class="cursor-pointer border-2 ${app.player.skin === s.id ? 'border-amber-400 ring-2 ring-amber-400/50' : 'border-slate-700'} p-2.5 bg-slate-950 flex flex-col items-center gap-1.5 transition">
      <div class="w-12 h-16 bg-gradient-to-br ${s.previewBg} border-2 ${s.border} flex items-center justify-center text-white/50 text-xs">✦</div>
      <span class="text-[11px] font-bold text-white text-center">${s.name}</span>
    </div>
  `).join('');

  // Table Skins
  document.getElementById('table-skins-grid').innerHTML = TABLE_SKINS.map(t => `
    <div data-table-id="${t.id}" class="cursor-pointer border-2 ${app.player.tableSkin === t.id ? 'border-amber-400 ring-2 ring-amber-400/50' : 'border-slate-700'} p-2.5 bg-slate-950 flex flex-col items-center gap-1.5 transition">
      <div class="w-12 h-12 bg-gradient-to-br ${t.previewBg} border-2 ${t.border} flex items-center justify-center text-lg">${t.icon}</div>
      <span class="text-[11px] font-bold text-white text-center">${t.name}</span>
    </div>
  `).join('');

  // Avatars
  document.getElementById('avatars-grid').innerHTML = AVATARS.map(av => `
    <div data-avatar-id="${av}" class="cursor-pointer w-11 h-11 bg-slate-950 border-2 ${app.player.avatar === av ? 'border-amber-400 ring-2 ring-amber-400/50' : 'border-slate-700'} flex items-center justify-center text-2xl transition">
      ${av}
    </div>
  `).join('');

  // Frames
  document.getElementById('frames-grid').innerHTML = AVATAR_FRAMES.map(fr => `
    <button data-frame-id="${fr.id}" class="px-2.5 py-1 text-xs font-bold border-2 ${fr.id} ${app.player.frame === fr.id ? 'bg-amber-400/20 text-white' : 'bg-slate-950 text-slate-300'}">
      ${fr.name}
    </button>
  `).join('');

  // Wiring
  document.querySelectorAll('[data-skin-id]').forEach(el => {
    el.addEventListener('click', () => { app.player.skin = el.dataset.skinId; renderCustomizeModal(); applyCosmetics(); });
  });
  document.querySelectorAll('[data-table-id]').forEach(el => {
    el.addEventListener('click', () => { app.player.tableSkin = el.dataset.tableId; renderCustomizeModal(); applyCosmetics(); });
  });
  document.querySelectorAll('[data-avatar-id]').forEach(el => {
    el.addEventListener('click', () => { app.player.avatar = el.dataset.avatarId; renderCustomizeModal(); });
  });
  document.querySelectorAll('[data-frame-id]').forEach(el => {
    el.addEventListener('click', () => { app.player.frame = el.dataset.frameId; renderCustomizeModal(); });
  });
}

// ==================== EVENT WIRING & INITIALIZATION ====================
window.addEventListener('DOMContentLoaded', async () => {
  // Sync initial profile
  await syncPlayerWithDB();

  // Populate Mode Cards in Lobby
  const modesGrid = document.getElementById('modes-grid');
  modesGrid.innerHTML = GAME_MODES.map(m => `
    <div data-mode-card="${m.id}" class="bg-slate-900/90 hover:bg-slate-800/95 border-2 border-slate-700 hover:border-amber-400 p-3.5 flex flex-col justify-between cursor-pointer transition pixel-box">
      <div>
        <div class="flex items-center justify-between gap-1 mb-1.5">
          <span class="text-2xl">${m.icon}</span>
          <span class="px-2 py-0.5 bg-slate-800 text-amber-300 text-[10px] font-bold border border-slate-700">${m.tag}</span>
        </div>
        <h3 class="text-xs font-bold text-white">${m.name}</h3>
        <p class="text-[11px] text-slate-400 mt-1 leading-relaxed">${m.desc}</p>
      </div>
      <div class="mt-3 pt-2 border-t border-slate-800 flex items-center justify-between text-[11px] text-amber-300 font-bold">
        <span>Mainkan</span>
        <span>→</span>
      </div>
    </div>
  `).join('');

  modesGrid.querySelectorAll('[data-mode-card]').forEach(card => {
    card.addEventListener('click', () => {
      const modeId = card.dataset.modeCard;
      document.getElementById('cr-mode').value = modeId;
      document.getElementById('modal-create-room').classList.remove('hidden');
    });
  });

  // Populate Mode Dropdown in Create Room
  document.getElementById('cr-mode').innerHTML = GAME_MODES.map(m => `
    <option value="${m.id}">${m.icon} ${m.name}</option>
  `).join('');

  // Emote Bar
  document.getElementById('emote-bar').innerHTML = EMOTES.map(e => `
    <button data-emote="${e.icon}" class="w-7 h-7 bg-slate-950 border border-slate-700 hover:border-amber-400 flex items-center justify-center text-sm transition" title="${e.label}">
      ${e.icon}
    </button>
  `).join('');

  document.querySelectorAll('[data-emote]').forEach(btn => {
    btn.addEventListener('click', () => sendEmote(btn.dataset.emote));
  });

  // Sound Toggle
  document.getElementById('btn-sound').addEventListener('click', () => {
    const on = SFX.toggle();
    document.getElementById('btn-sound').innerHTML = `<span class="text-sm leading-none">${on ? '🔊' : '🔇'}</span>`;
    showToast(on ? 'Suara diaktifkan' : 'Suara dimatikan');
  });

  // Save Player Name (Ganti Nama)
  document.getElementById('btn-save-name').addEventListener('click', () => {
    const newName = document.getElementById('input-player-name').value.trim();
    renamePlayer(newName);
  });
  document.getElementById('input-player-name').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      renamePlayer(e.target.value.trim());
    }
  });

  // Auth Modal Tabs & Actions
  const btnAuthOpen = document.getElementById('btn-auth-open');
  const modalAuth = document.getElementById('modal-auth');
  const tabLogin = document.getElementById('auth-tab-login');
  const tabReg = document.getElementById('auth-tab-register');
  const formLogin = document.getElementById('form-auth-login');
  const formReg = document.getElementById('form-auth-register');

  btnAuthOpen.addEventListener('click', () => {
    document.getElementById('login-error').classList.add('hidden');
    document.getElementById('reg-error').classList.add('hidden');
    modalAuth.classList.remove('hidden');
  });

  tabLogin.addEventListener('click', () => {
    tabLogin.className = 'pixel-font text-xs text-amber-300 border-b-2 border-amber-400 pb-1';
    tabReg.className = 'pixel-font text-xs text-slate-400 pb-1';
    formLogin.classList.remove('hidden');
    formReg.classList.add('hidden');
  });

  tabReg.addEventListener('click', () => {
    tabReg.className = 'pixel-font text-xs text-emerald-300 border-b-2 border-emerald-400 pb-1';
    tabLogin.className = 'pixel-font text-xs text-slate-400 pb-1';
    formReg.classList.remove('hidden');
    formLogin.classList.add('hidden');
  });

  formLogin.addEventListener('submit', async (e) => {
    e.preventDefault();
    const u = document.getElementById('login-username').value.trim();
    const p = document.getElementById('login-password').value;
    await loginPlayer(u, p);
  });

  formReg.addEventListener('submit', async (e) => {
    e.preventDefault();
    const u = document.getElementById('reg-username').value.trim();
    const name = document.getElementById('reg-name').value.trim();
    const p = document.getElementById('reg-password').value;
    await registerPlayer(u, p, name);
  });

  document.getElementById('btn-logout').addEventListener('click', logoutPlayer);

  // In-Game Quick Chat & Form
  document.querySelectorAll('.ingame-quick-chat').forEach(btn => {
    btn.addEventListener('click', () => {
      sendChatMessage(btn.textContent);
    });
  });

  document.getElementById('ingame-mini-chat-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const inp = document.getElementById('ingame-mini-chat-input');
    const txt = inp.value.trim();
    if (txt) {
      sendChatMessage(txt);
      inp.value = '';
    }
  });

  // Refresh Rooms Button
  document.getElementById('btn-refresh-rooms').addEventListener('click', () => {
    refreshRoomsList();
    SFX.card();
  });

  // Create Room modal opening
  document.getElementById('btn-quick-create-room').addEventListener('click', () => {
    document.getElementById('modal-create-room').classList.remove('hidden');
  });

  // Password checkbox toggle
  document.getElementById('cr-use-pass').addEventListener('change', (e) => {
    document.getElementById('cr-pass-wrap').classList.toggle('hidden', !e.target.checked);
  });

  // Create Room form submit
  document.getElementById('form-create-room').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = document.getElementById('cr-name').value.trim();
    const mode = document.getElementById('cr-mode').value;
    const maxPlayers = Number(document.getElementById('cr-max').value);
    const isPrivate = document.getElementById('cr-use-pass').checked;
    const password = isPrivate ? document.getElementById('cr-password').value.trim() : '';

    if (isPrivate && !password) {
      showToast('Masukkan password ruangan!', 'warn');
      return;
    }

    const res = await apiPost('/api/rooms', {
      name,
      mode,
      maxPlayers,
      password,
      isPrivate,
      hostId: app.player.id
    });

    if (res.ok && res.room) {
      document.getElementById('modal-create-room').classList.add('hidden');
      showToast(`Ruangan #${res.room.code} berhasil dibuat!`, 'success');
      joinRoom(res.room.id);
    } else {
      showToast(res.error || 'Gagal membuat ruangan', 'error');
    }
  });

  // Join Room by Code
  document.getElementById('btn-join-by-code').addEventListener('click', () => {
    const raw = document.getElementById('input-join-code').value.trim().toUpperCase().replace(/^#/, '');
    if (!raw) {
      showToast('Ketik kode ruangan (contoh: KRT-1234)', 'warn');
      return;
    }
    joinRoom(raw);
  });

  // Join Password form submit
  document.getElementById('form-join-password').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!app.pendingJoinRoom) return;
    const pass = document.getElementById('jp-input').value.trim();
    const ok = await joinRoom(app.pendingJoinRoom.id, pass);
    if (ok) {
      document.getElementById('modal-join-password').classList.add('hidden');
    } else {
      document.getElementById('jp-error').classList.remove('hidden');
    }
  });

  // Lounge Actions
  document.getElementById('btn-copy-invite-link').addEventListener('click', () => {
    if (!app.currentRoom) return;
    const url = `${window.location.origin}/?join=${app.currentRoom.code}`;
    navigator.clipboard?.writeText(url).then(() => {
      showToast('Link undangan disalin ke clipboard! 📋', 'success');
    }).catch(() => {
      prompt('Salin link undangan ini:', url);
    });
  });

  document.getElementById('btn-lounge-ready').addEventListener('click', async () => {
    if (!app.currentRoom) return;
    const myPl = app.roomPlayers.find(p => p.id === app.player.id);
    const newReady = !(myPl && myPl.is_ready);
    await apiPost(`/api/rooms/${app.currentRoom.id}/ready`, {
      playerId: app.player.id,
      isReady: newReady
    });
    document.getElementById('btn-lounge-ready').textContent = newReady ? '❌ Batal Siap' : '✅ Saya Siap!';
  });

  document.getElementById('btn-lounge-fill-bots').addEventListener('click', async () => {
    if (!app.currentRoom) return;
    await apiPost(`/api/rooms/${app.currentRoom.id}/fill-bots`, {});
    showToast('Kursi kosong diisi oleh Bot AI!', 'success');
  });

  document.getElementById('btn-lounge-start').addEventListener('click', async () => {
    if (!app.currentRoom) return;
    const res = await apiPost(`/api/rooms/${app.currentRoom.id}/start`, {
      hostId: app.player.id
    });
    if (res.ok) {
      switchToGameView();
    } else {
      showToast(res.error || 'Gagal memulai permainan', 'error');
    }
  });

  document.getElementById('btn-lounge-leave').addEventListener('click', async () => {
    if (!app.currentRoom) return;
    await apiPost(`/api/rooms/${app.currentRoom.id}/leave`, { playerId: app.player.id });
    if (app.sseSource) app.sseSource.close();
    app.currentRoom = null;
    switchView('lobby');
    refreshRoomsList();
  });

  document.getElementById('btn-back-lobby').addEventListener('click', () => {
    switchView('lobby');
    refreshRoomsList();
  });

  // Chat Panel Toggle & Submit
  const chatPanel = document.getElementById('chat-panel');
  document.getElementById('btn-toggle-chat').addEventListener('click', () => {
    app.chatOpen = !app.chatOpen;
    chatPanel.classList.toggle('hidden', !app.chatOpen);
    if (app.chatOpen) {
      app.unreadChat = 0;
      document.getElementById('chat-unread-badge').classList.add('hidden');
    }
  });
  document.getElementById('btn-close-chat').addEventListener('click', () => {
    app.chatOpen = false;
    chatPanel.classList.add('hidden');
  });

  document.getElementById('chat-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const inp = document.getElementById('chat-input');
    const msg = inp.value.trim();
    if (!msg || !app.currentRoom) return;
    sendChatMessage(msg);
    inp.value = '';
  });

  document.querySelectorAll('.quick-chat-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      sendChatMessage(btn.textContent);
    });
  });

  // Modal Closers
  document.querySelectorAll('[data-close-modal]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.getElementById(btn.dataset.closeModal).classList.add('hidden');
    });
  });

  // Leaderboard modal
  document.getElementById('btn-leaderboard').addEventListener('click', showLeaderboard);

  // Customize modal
  document.getElementById('btn-customize').addEventListener('click', () => {
    renderCustomizeModal();
    document.getElementById('modal-customize').classList.remove('hidden');
  });
  document.getElementById('lobby-avatar-preview').addEventListener('click', () => {
    renderCustomizeModal();
    document.getElementById('modal-customize').classList.remove('hidden');
  });

  document.getElementById('btn-save-cosmetics').addEventListener('click', async () => {
    localStorage.setItem('carena_skin', app.player.skin);
    localStorage.setItem('carena_table_skin', app.player.tableSkin);
    localStorage.setItem('carena_player_avatar', app.player.avatar);
    localStorage.setItem('carena_player_frame', app.player.frame);
    await syncPlayerWithDB();
    document.getElementById('modal-customize').classList.add('hidden');
    showToast('Kustomisasi disimpan ke database!', 'success');
  });

  // Mode rules modal
  document.getElementById('btn-mode-rules').addEventListener('click', () => {
    const curMode = app.game ? app.game.mode : 'capsa';
    const m = GAME_MODES.find(x => x.id === curMode);
    if (!m) return;
    document.getElementById('rules-modal-title').textContent = `ATURAN ${m.name.toUpperCase()}`;
    document.getElementById('rules-modal-body').textContent = m.rules;
    document.getElementById('modal-rules').classList.remove('hidden');
  });

  // Delete Room buttons (in Lounge & in Game)
  document.getElementById('btn-lounge-delete')?.addEventListener('click', deleteCurrentRoom);
  document.getElementById('btn-game-delete-room')?.addEventListener('click', deleteCurrentRoom);

  // Start unified heartbeat sync loop & 60s turn countdown ticker
  startHeartbeatSync();
  startTurnCountdownTicker();

  // Check URL query param for invite link (?join=KRT-XXXX)
  const urlParams = new URLSearchParams(window.location.search);
  const joinCode = urlParams.get('join');
  if (joinCode) {
    document.getElementById('input-join-code').value = joinCode;
    showToast(`Mencoba bergabung ke ruangan #${joinCode}...`, 'info');
    joinRoom(joinCode);
  }
});
