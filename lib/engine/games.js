const { createDeck, shuffle, SUITS, RANKS, CAPSA_RANK_ORDER, capsaValue, sortCapsaHand, rankNum } = require('./cards');
const { isThreeOfDiamonds, capsaEvaluateHand, capsaValidateSelection, capsaFindCombosByType } = require('./capsa');

const MINUMAN_RULES = {
  'A': { title: 'Air Terjun! 🌊', text: 'Semua pemain angkat gelas serentak! Berhenti setelah pemain di kanan berhenti.' },
  '2': { title: 'Tunjuk Teman 👉', text: 'Pilih satu pemain di meja untuk melakukan tantangan atau minum 1 teguk.' },
  '3': { title: 'Untuk Diri Sendiri 🥤', text: 'Penarik kartu minum/ambil poin penalti sendiri!' },
  '4': { title: 'Sentuh Meja! 🖐️', text: 'Semua harus sentuh meja. Yang paling lambat kena penalti!' },
  '5': { title: 'Tim Cowok / Ganjil 👨', text: 'Semua pemain kursi bernomor ganjil angkat gelas bareng!' },
  '6': { title: 'Tim Cewek / Genap 👩', text: 'Semua pemain kursi bernomor genap angkat gelas bareng!' },
  '7': { title: 'Angkat Tangan! 🙌', text: 'Semua angkat tangan ke atas. Yang paling lambat kena giliran!' },
  '8': { title: 'Cari Pasangan 🤝', text: 'Pilih 1 partner: setiap kali kamu kena tantangan, dia ikut!' },
  '9': { title: 'Rima Kata 🎤', text: 'Ucapkan 1 kata, pemain berikutnya harus menyambung kata berima!' },
  '10': { title: 'Kategori Cepat 🏷️', text: 'Sebutkan kategori, sebut bergiliran tanpa mengulang!' },
  'J': { title: 'Buat Aturan Baru 📜', text: 'Kamu boleh membuat 1 aturan bebas yang berlaku sampai ronde selesai!' },
  'Q': { title: 'Tanya Jawab ❓', text: 'Ajukan pertanyaan ke lawan; siapa yang gagal membalas dengan pertanyaan kalah!' },
  'K': { title: 'GELAS RAJA! 👑', text: 'Tuang ke Gelas Raja di tengah! Penarik King ke-4 menyelesaikan Gelas Raja!' }
};

function stripPairs(hand) {
  const counts = {};
  hand.forEach(c => {
    if (!c.isJoker) counts[c.rank] = (counts[c.rank] || 0) + 1;
  });
  const kept = [];
  const oddRanks = new Set();
  Object.keys(counts).forEach(r => {
    if (counts[r] % 2 === 1) oddRanks.add(r);
  });
  hand.forEach(c => {
    if (c.isJoker) kept.push(c);
    else if (oddRanks.has(c.rank)) {
      kept.push(c);
      oddRanks.delete(c.rank);
    }
  });
  return shuffle(kept);
}

function calc41Score(hand) {
  if (!hand || !hand.length) return 0;
  const suitScores = { '♦': 0, '♣': 0, '♥': 0, '♠': 0 };
  hand.forEach(c => {
    let pts = 0;
    if (c.rank === 'A') pts = 11;
    else if (['K', 'Q', 'J', '10'].includes(c.rank)) pts = 10;
    else pts = Number(c.rank) || 0;
    if (suitScores[c.suit] !== undefined) suitScores[c.suit] += pts;
  });
  return Math.max(...Object.values(suitScores));
}

function bjValue(hand) {
  if (!hand || !hand.length) return 0;
  let total = 0;
  let aces = 0;
  hand.forEach(c => {
    if (c.rank === 'A') { aces++; total += 11; }
    else if (['K', 'Q', 'J'].includes(c.rank)) { total += 10; }
    else { total += Number(c.rank) || 0; }
  });
  while (total > 21 && aces > 0) {
    total -= 10;
    aces--;
  }
  return total;
}

function isSevenUpPlayable(card, board) {
  if (!card) return false;
  const lane = board[card.suit];
  const num = rankNum(card.rank);
  if (!lane) return num === 7;
  return num === lane.low - 1 || num === lane.high + 1;
}

// ================= INITIALIZE GAME STATE =================
function initGame(mode, players) {
  const playerCount = players.length;
  const g = {
    mode,
    players: players.map((p, idx) => ({
      id: idx,
      playerId: p.id,
      name: p.name,
      avatar: p.avatar,
      frame: p.frame,
      isBot: !!(p.isBot || p.is_bot || (p.id && String(p.id).startsWith('bot_'))),
      hand: [],
      score: 0,
      books: 0,
      bet: 100,
      status: ''
    })),
    turn: 0,
    finished: false,
    winnerText: '',
    winnerIdx: null,
    status: 'Permainan dimulai!',
    history: []
  };

  if (mode === 'capsa') {
    const deck = createDeck(1);
    const perPlayer = Math.floor(52 / playerCount);
    // Keep equal starting hands while guaranteeing the opening card is dealt.
    const dealtCount = perPlayer * playerCount;
    const opener = deck.findIndex(isThreeOfDiamonds);
    if (opener >= dealtCount) [deck[dealtCount - 1], deck[opener]] = [deck[opener], deck[dealtCount - 1]];
    for (let i = 0; i < playerCount; i++) {
      g.players[i].hand = sortCapsaHand(deck.slice(i * perPlayer, (i + 1) * perPlayer));
    }
    // Find player with 3 of diamonds
    let starter = 0;
    for (let i = 0; i < playerCount; i++) {
      if (g.players[i].hand.some(isThreeOfDiamonds)) {
        starter = i;
        break;
      }
    }
    g.turn = starter;
    g.tablePlay = null;
    g.passCount = 0;
    g.mustInclude3D = true;
    g.status = `${g.players[starter].name} memegang 3♦ dan membuka permainan!`;
  } else if (mode === 'setan') {
    const deck = createDeck(1, true);
    let cur = 0;
    deck.forEach(c => {
      g.players[cur % playerCount].hand.push(c);
      cur++;
    });
    g.players.forEach(p => {
      p.hand = stripPairs(p.hand);
    });
    g.lastActionText = 'Semua pasangan kartu awal otomatis dibuang. Mulai cabut kartu!';
    g.turn = g.players.findIndex(p => p.hand.length);
    finishSetanIfNeeded(g, g.turn);
    if (!g.finished) g.status = `Giliran ${g.players[g.turn].name} mencabut kartu.`;
  } else if (mode === 'sevenup') {
    const deck = createDeck(1);
    deck.forEach((card, index) => g.players[index % playerCount].hand.push(card));
    g.board = { '♦': null, '♣': null, '♥': null, '♠': null };
    g.turn = 0;
    g.passStreak = 0;
    g.status = 'Keluarkan kartu angka 7 untuk membuka kembang!';
  } else if (mode === 'gofish') {
    const deck = createDeck(1);
    const handSize = playerCount <= 4 ? 7 : 5;
    for (let i = 0; i < playerCount; i++) {
      g.players[i].hand = deck.splice(0, handSize);
      checkGoFishBooks(g.players[i]);
    }
    g.deck = deck;
    g.turn = 0;
    g.lastFishLog = 'Minta angka yang ada di tanganmu ke salah satu lawan!';
    prepareGoFishTurn(g);
    if (!g.finished) g.status = `Giliran ${g.players[g.turn].name}.`;
  } else if (mode === 'bohong') {
    const deck = createDeck(1);
    const perPlayer = Math.floor(52 / playerCount);
    for (let i = 0; i < playerCount; i++) {
      g.players[i].hand = deck.slice(i * perPlayer, (i + 1) * perPlayer);
    }
    g.pile = [];
    g.targetRankIdx = 0; // Starts at 'A'
    g.lastClaim = null;
    g.turn = 0;
    g.status = `Target angka: A. ${g.players[0].name} jalan duluan.`;
  } else if (mode === 'empatsatu') {
    const deck = createDeck(1);
    for (let i = 0; i < playerCount; i++) {
      g.players[i].hand = deck.splice(0, 4);
    }
    g.discard = [deck.pop()];
    g.deck = deck;
    g.turn = 0;
    g.phase = 'draw'; // 'draw' then 'discard'
    g.status = `${g.players[0].name}: Ambil 1 kartu dari Dek atau Buangan.`;
  } else if (mode === 'minuman') {
    g.deck = createDeck(1);
    g.kingCount = 0;
    g.currentRule = null;
    g.turn = 0;
    g.status = 'Tarik kartu dari lingkaran tengah!';
  } else if (mode === 'blackjack') {
    const deck = createDeck(2);
    for (let i = 0; i < playerCount; i++) {
      g.players[i].hand = [deck.pop(), deck.pop()];
      g.players[i].status = '';
    }
    g.dealer = {
      hand: [deck.pop(), deck.pop()],
      revealed: false
    };
    g.deck = deck;
    g.turn = 0;
    g.status = `Giliran ${g.players[0].name}: Hit, Stand, atau Double?`;
  }

  g.turnStartedAt = Date.now();
  g.turnTimeLimitSec = 60;
  return g;
}

function checkGoFishBooks(p) {
  const counts = {};
  p.hand.forEach(c => { counts[c.rank] = (counts[c.rank] || 0) + 1; });
  Object.keys(counts).forEach(r => {
    if (counts[r] === 4) {
      p.hand = p.hand.filter(c => c.rank !== r);
      p.books = (p.books || 0) + 1;
    }
  });
}

function prepareGoFishTurn(g) {
  const players = g.players;
  const count = players.length;
  for (let step = 0; step < count; step++) {
    const player = players[g.turn];
    while (!player.hand.length && g.deck.length) {
      player.hand.push(g.deck.pop());
      checkGoFishBooks(player);
    }
    if (player.hand.length) break;
    g.turn = (g.turn + 1) % count;
  }

  const next = (g.turn + 1) % count;
  if (!players.some(p => p.id !== g.turn && p.hand.length) && g.deck.length) {
    players[next].hand.push(g.deck.pop());
  }
  if (g.deck.length || players.some(p => p.id !== g.turn && p.hand.length)) return;

  // Once the stock and opponents' hands are empty, the remaining cards form books.
  checkGoFishBooks(players[g.turn]);
  const winner = [...players].sort((a, b) => b.books - a.books)[0];
  g.finished = true;
  g.winnerIdx = winner.id;
  g.winnerText = `👑 ${winner.name} Menang Go Fish dengan ${winner.books} Book!`;
  g.status = g.winnerText;
}

function finishSetanIfNeeded(g, actingSeat) {
  const active = g.players.filter(p => p.hand.length > 0);
  if (active.length !== 1) return;
  const loser = active[0];
  g.finished = true;
  g.winnerIdx = actingSeat === loser.id ? g.players.find(p => p.id !== loser.id).id : actingSeat;
  g.winnerText = `👹 ${loser.name} Kalah! Masih memegang Kartu SETAN!`;
  g.status = g.winnerText;
}

// Older Capsa rounds may lack the opening card because it was left undealt.
function repairCapsaOpening(g) {
  if (g.mode !== 'capsa' || g.finished || !g.mustInclude3D) return;
  const starter = g.players.findIndex(p => p.hand.some(isThreeOfDiamonds));
  if (starter === -1) {
    g.mustInclude3D = false;
    g.status = `${g.players[g.turn].name} membuka permainan.`;
  }
}

function findPrevActiveSetan(g, fromIdx) {
  const n = g.players.length;
  for (let step = 1; step < n; step++) {
    const idx = (fromIdx - step + n) % n;
    if (g.players[idx].hand.length > 0) return idx;
  }
  return -1;
}

function findNextActiveSetan(g, fromIdx) {
  const n = g.players.length;
  for (let step = 1; step < n; step++) {
    const idx = (fromIdx + step) % n;
    if (g.players[idx].hand.length > 0) return idx;
  }
  return -1;
}

// ================= PROCESS ACTION =================
function processGameActionInternal(g, playerIdx, action, payload = {}) {
  if (g.finished) return { ok: false, error: 'Permainan sudah selesai!' };

  // 1. CAPSA
  if (g.mode === 'capsa') {
    if (g.turn !== playerIdx) return { ok: false, error: 'Bukan giliranmu!' };
    const p = g.players[playerIdx];

    if (action === 'play') {
      const cardIds = payload.cardIds || [];
      const cards = p.hand.filter(c => cardIds.includes(c.id));
      const val = capsaValidateSelection(cards, g.tablePlay, g.mustInclude3D);
      if (!val.ok) return { ok: false, error: val.msg };

      p.hand = p.hand.filter(c => !cardIds.includes(c.id));
      g.tablePlay = { by: playerIdx, cards, evaluation: val.evalNew, label: val.evalNew.label };
      g.passCount = 0;
      g.mustInclude3D = false;
      g.lastAction = { type: 'play', by: playerIdx, name: p.name, text: val.evalNew.label };

      if (p.hand.length === 0) {
        g.finished = true;
        g.winnerIdx = playerIdx;
        g.winnerText = `👑 ${p.name} Menang Capsa Banting!`;
        g.status = g.winnerText;
        return { ok: true, g };
      }

      g.turn = (g.turn + 1) % g.players.length;
      g.status = `${p.name} mengeluarkan ${val.evalNew.label}. Giliran ${g.players[g.turn].name}.`;
      return { ok: true, g };
    }

    if (action === 'pass') {
      if (g.mustInclude3D) return { ok: false, error: 'Langkah pertama tidak boleh Pass (wajib 3♦)!' };
      if (!g.tablePlay) return { ok: false, error: 'Meja kosong, tidak bisa pass!' };

      g.passCount++;
      g.lastAction = { type: 'pass', by: playerIdx, name: p.name, text: 'Pass ✋' };
      const nextTurn = (g.turn + 1) % g.players.length;
      if (g.passCount >= g.players.length - 1) {
        g.tablePlay = null;
        g.passCount = 0;
        g.status = `Semua pemain pass! Meja dibersihkan. Giliran ${g.players[nextTurn].name} bebas mengeluarkan kartu.`;
      } else {
        g.status = `${p.name} Pass. Giliran ${g.players[nextTurn].name}.`;
      }
      g.turn = nextTurn;
      return { ok: true, g };
    }
  }

  // 2. SETAN-SETAN
  if (g.mode === 'setan') {
    if (g.turn !== playerIdx) return { ok: false, error: 'Bukan giliranmu!' };
    if (action === 'draw') {
      const prevIdx = findPrevActiveSetan(g, playerIdx);
      if (prevIdx === -1) return { ok: false, error: 'Tidak ada pemain aktif tersisa!' };
      const target = g.players[prevIdx];
      const cardIdx = payload.cardIndex;
      if (!Number.isInteger(cardIdx) || cardIdx < 0 || cardIdx >= target.hand.length) {
        return { ok: false, error: 'Pilihan kartu tidak valid!' };
      }

      const [drawn] = target.hand.splice(cardIdx, 1);
      const drawer = g.players[playerIdx];
      drawer.hand.push(drawn);
      drawer.hand = stripPairs(drawer.hand);
      target.hand = stripPairs(target.hand);

      g.lastActionText = `${drawer.name} mencabut 1 kartu dari ${target.name}.`;

      finishSetanIfNeeded(g, playerIdx);
      if (g.finished) return { ok: true, g };

      g.turn = findNextActiveSetan(g, playerIdx);
      g.status = `Giliran ${g.players[g.turn].name}.`;
      return { ok: true, g };
    }
  }

  // 3. SEVEN UP
  if (g.mode === 'sevenup') {
    if (g.turn !== playerIdx) return { ok: false, error: 'Bukan giliranmu!' };
    const p = g.players[playerIdx];

    if (action === 'play') {
      const card = p.hand.find(c => c.id === payload.cardId);
      if (!card || !isSevenUpPlayable(card, g.board)) {
        return { ok: false, error: 'Kartu tidak bisa ditaruh di meja saat ini!' };
      }

      p.hand = p.hand.filter(c => c.id !== card.id);
      const num = rankNum(card.rank);
      if (!g.board[card.suit]) {
        g.board[card.suit] = { low: 7, high: 7 };
      } else if (num < g.board[card.suit].low) {
        g.board[card.suit].low = num;
      } else if (num > g.board[card.suit].high) {
        g.board[card.suit].high = num;
      }

      g.passStreak = 0;
      g.lastAction = { type: 'play', by: playerIdx, name: p.name, text: `${card.rank}${card.suit}` };
      if (p.hand.length === 0) {
        g.finished = true;
        g.winnerIdx = playerIdx;
        g.winnerText = `👑 ${p.name} Menang Seven Up! (Kartu habis)`;
        g.status = g.winnerText;
        return { ok: true, g };
      }

      g.turn = (g.turn + 1) % g.players.length;
      g.status = `${p.name} menaruh ${card.rank}${card.suit}. Giliran ${g.players[g.turn].name}.`;
      return { ok: true, g };
    }

    if (action === 'pass') {
      g.passStreak++;
      g.lastAction = { type: 'pass', by: playerIdx, name: p.name, text: 'Pass ✋' };
      if (g.passStreak >= g.players.length * 2) {
        g.finished = true;
        // Winner is player with fewest cards
        const sorted = [...g.players].sort((a, b) => a.hand.length - b.hand.length);
        g.winnerIdx = sorted[0].id;
        g.winnerText = `Permainan berakhir! ${sorted[0].name} menang dengan sisa kartu paling sedikit (${sorted[0].hand.length}).`;
        g.status = g.winnerText;
        return { ok: true, g };
      }
      g.turn = (g.turn + 1) % g.players.length;
      g.status = `${p.name} Pass. Giliran ${g.players[g.turn].name}.`;
      return { ok: true, g };
    }
  }

  // 4. GO FISH
  if (g.mode === 'gofish') {
    if (g.turn !== playerIdx) return { ok: false, error: 'Bukan giliranmu!' };
    if (action === 'ask') {
      const targetIdx = Number(payload.targetIdx);
      const rank = payload.rank;
      const asker = g.players[playerIdx];
      const target = g.players[targetIdx];

      if (!target || targetIdx === playerIdx) return { ok: false, error: 'Pilih lawan yang valid!' };
      if (!asker.hand.some(c => c.rank === rank)) return { ok: false, error: `Kamu harus punya kartu ${rank} di tangan!` };

      const stolen = target.hand.filter(c => c.rank === rank);
      if (stolen.length > 0) {
        target.hand = target.hand.filter(c => c.rank !== rank);
        asker.hand.push(...stolen);
        checkGoFishBooks(asker);
        g.lastFishLog = `Berhasil! ${asker.name} dapat ${stolen.length} kartu ${rank} dari ${target.name}. Main lagi!`;
      } else {
        if (g.deck.length > 0) {
          const drawn = g.deck.pop();
          asker.hand.push(drawn);
          checkGoFishBooks(asker);
          if (drawn.rank === rank) {
            g.lastFishLog = `Go Fish! ${asker.name} menarik kartu ${rank} yang pas dari dek! Main lagi!`;
          } else {
            g.lastFishLog = `Go Fish! ${asker.name} menarik 1 kartu dari dek. Giliran berganti.`;
            g.turn = (g.turn + 1) % g.players.length;
          }
        } else {
          g.lastFishLog = `Dek habis! Giliran berganti.`;
          g.turn = (g.turn + 1) % g.players.length;
        }
      }

      prepareGoFishTurn(g);
      if (!g.finished) g.status = g.lastFishLog;
      return { ok: true, g };
    }
  }

  // 5. BOHONG-BOHONGAN
  if (g.mode === 'bohong') {
    if (action === 'play') {
      if (g.turn !== playerIdx) return { ok: false, error: 'Bukan giliranmu!' };
      const p = g.players[playerIdx];
      const cardIds = payload.cardIds || [];
      if (cardIds.length === 0 || cardIds.length > 3) return { ok: false, error: 'Pilih 1–3 kartu!' };

      const cards = p.hand.filter(c => cardIds.includes(c.id));
      if (cards.length !== cardIds.length) return { ok: false, error: 'Kartu yang dipilih tidak valid!' };
      p.hand = p.hand.filter(c => !cardIds.includes(c.id));
      g.pile.push(...cards);

      const targetRank = RANKS[g.targetRankIdx];
      const isBluff = cards.some(c => c.rank !== targetRank);
      g.lastClaim = { by: playerIdx, cards, claimedRank: targetRank, isBluff };
      g.lastAction = { type: 'play', by: playerIdx, name: p.name, text: `${cards.length}x ${targetRank}` };

      if (p.hand.length === 0) {
        g.finished = true;
        g.winnerIdx = playerIdx;
        g.winnerText = `👑 ${p.name} Menang Bohong-bohongan! Kartu habis!`;
        g.status = g.winnerText;
        return { ok: true, g };
      }

      g.targetRankIdx = (g.targetRankIdx + 1) % RANKS.length;
      g.turn = (g.turn + 1) % g.players.length;
      g.status = `${p.name} menaruh ${cards.length} kartu (klaim: ${targetRank}). Target berikutnya: ${RANKS[g.targetRankIdx]}.`;
      return { ok: true, g };
    }

    if (action === 'call_bluff') {
      if (!g.lastClaim) return { ok: false, error: 'Belum ada kartu yang ditaruh!' };
      if (g.lastClaim.by === playerIdx) return { ok: false, error: 'Tidak bisa menuduh diri sendiri!' };

      const accuser = g.players[playerIdx];
      const claimant = g.players[g.lastClaim.by];

      if (g.lastClaim.isBluff) {
        claimant.hand.push(...g.pile);
        g.status = `🚨 BOHONG TERBUKTI! ${claimant.name} berbohong dan mengambil ${g.pile.length} kartu meja!`;
      } else {
        accuser.hand.push(...g.pile);
        g.status = `✅ JUJUR! ${claimant.name} jujur! ${accuser.name} salah tuduh dan mengambil ${g.pile.length} kartu meja!`;
      }
      g.pile = [];
      g.lastClaim = null;
      return { ok: true, g };
    }
  }

  // 6. EMPAT SATU (4-1)
  if (g.mode === 'empatsatu') {
    if (g.turn !== playerIdx) return { ok: false, error: 'Bukan giliranmu!' };
    const p = g.players[playerIdx];

    if (action === 'draw') {
      if (g.phase !== 'draw') return { ok: false, error: 'Kamu harus membuang kartu terlebih dahulu!' };
      const source = payload.source; // 'deck' or 'discard'
      if (source === 'deck') {
        if (g.deck.length === 0) {
          g.deck = shuffle(g.discard.splice(0, g.discard.length - 1));
        }
        p.hand.push(g.deck.pop());
      } else if (source === 'discard') {
        if (g.discard.length === 0) return { ok: false, error: 'Tumpukan buangan kosong!' };
        p.hand.push(g.discard.pop());
      } else {
        return { ok: false, error: 'Pilih dek atau tumpukan buangan!' };
      }
      g.phase = 'discard';
      g.status = `${p.name} mengambil kartu. Pilih 1 kartu untuk dibuang.`;
      return { ok: true, g };
    }

    if (action === 'discard') {
      if (g.phase !== 'discard') return { ok: false, error: 'Ambil kartu terlebih dahulu!' };
      const card = p.hand.find(c => c.id === payload.cardId);
      if (!card) return { ok: false, error: 'Kartu tidak ditemukan!' };

      p.hand = p.hand.filter(c => c.id !== card.id);
      g.discard.push(card);
      g.lastAction = { type: 'discard', by: playerIdx, name: p.name, text: `Buang ${card.rank}${card.suit}` };

      const score = calc41Score(p.hand);
      if (score === 41) {
        g.finished = true;
        g.winnerIdx = playerIdx;
        g.winnerText = `🎯 4-1 SEMPURNA! ${p.name} mencapai 41 poin sekembang!`;
        g.status = g.winnerText;
        return { ok: true, g };
      }

      g.phase = 'draw';
      g.turn = (g.turn + 1) % g.players.length;
      g.status = `${p.name} membuang ${card.rank}${card.suit}. Giliran ${g.players[g.turn].name}.`;
      return { ok: true, g };
    }

    if (action === 'knock') {
      g.finished = true;
      const scores = g.players.map(pl => ({ id: pl.id, name: pl.name, score: calc41Score(pl.hand) }));
      scores.sort((a, b) => b.score - a.score);
      g.winnerIdx = scores[0].id;
      g.winnerText = `🏆 ${scores[0].name} Menang 4-1 dengan skor tertinggi (${scores[0].score})!`;
      g.status = g.winnerText;
      return { ok: true, g };
    }
  }

  // 7. MINUMAN (PARTY)
  if (g.mode === 'minuman') {
    if (g.turn !== playerIdx) return { ok: false, error: 'Bukan giliranmu!' };
    const p = g.players[playerIdx];

    if (action === 'draw') {
      if (g.deck.length === 0) {
        g.finished = true;
        g.winnerText = 'Lingkaran habis! Selesai!';
        g.status = g.winnerText;
        return { ok: true, g };
      }

      const card = g.deck.pop();
      p.score = (p.score || 0) + 1;
      const rule = MINUMAN_RULES[card.rank] || { title: `Kartu ${card.rank}${card.suit}`, text: 'Tantangan bebas!' };
      g.currentRule = { ...rule, card: `${card.rank}${card.suit}`, by: p.name };

      if (card.rank === 'K') {
        g.kingCount = (g.kingCount || 0) + 1;
        if (g.kingCount >= 4) {
          g.finished = true;
          g.winnerIdx = playerIdx;
          g.winnerText = `👑 KING KE-4! ${p.name} menyelesaikan Gelas Raja! Ronde selesai!`;
          g.status = g.winnerText;
          return { ok: true, g };
        }
      }

      g.turn = (g.turn + 1) % g.players.length;
      g.status = `${p.name} menarik ${card.rank}${card.suit}: ${rule.title}`;
      return { ok: true, g };
    }
  }

  // 8. BLACKJACK 21
  if (g.mode === 'blackjack') {
    if (g.turn !== playerIdx) return { ok: false, error: 'Bukan giliranmu!' };
    const p = g.players[playerIdx];

    if (action === 'hit') {
      p.hand.push(g.deck.pop());
      const val = bjValue(p.hand);
      if (val > 21) {
        p.status = 'BUST (>21)';
        advanceBlackjack(g);
      } else {
        g.status = `${p.name} Hit (Total: ${val}). Hit atau Stand?`;
      }
      return { ok: true, g };
    }

    if (action === 'stand') {
      p.status = `Stand (${bjValue(p.hand)})`;
      advanceBlackjack(g);
      return { ok: true, g };
    }

    if (action === 'double') {
      p.bet = (p.bet || 100) * 2;
      p.hand.push(g.deck.pop());
      const val = bjValue(p.hand);
      p.status = val > 21 ? 'BUST (>21)' : `Double Stand (${val})`;
      advanceBlackjack(g);
      return { ok: true, g };
    }
  }

  return { ok: false, error: 'Aksi tidak dikenal' };
}

function processGameAction(g, playerIdx, action, payload = {}) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) ||
      (payload.cardIds !== undefined && !Array.isArray(payload.cardIds))) {
    return { ok: false, error: 'Data aksi kartu tidak valid!' };
  }
  const res = processGameActionInternal(g, playerIdx, action, payload);
  if (res.ok && !g.finished) {
    g.turnStartedAt = Date.now();
    g.turnTimeLimitSec = 60;
  }
  return res;
}

function advanceBlackjack(g) {
  g.turn++;
  if (g.turn < g.players.length) {
    g.status = `Giliran ${g.players[g.turn].name}.`;
    return;
  }

  // Dealer turn
  g.dealer.revealed = true;
  while (bjValue(g.dealer.hand) < 17) {
    g.dealer.hand.push(g.deck.pop());
  }
  const dVal = bjValue(g.dealer.hand);
  const dBust = dVal > 21;

  let winSummary = [];
  g.players.forEach(p => {
    const pVal = bjValue(p.hand);
    if (pVal > 21) {
      p.result = 'Kalah (Bust)';
    } else if (dBust || pVal > dVal) {
      p.result = 'Menang! (+Koin)';
      winSummary.push(p.name);
    } else if (pVal === dVal) {
      p.result = 'Seri (Push)';
    } else {
      p.result = 'Kalah dari Bandar';
    }
  });

  g.finished = true;
  g.turn = 0;
  g.winnerText = winSummary.length ? `Pemenang vs Bandar: ${winSummary.join(', ')}` : 'Semua pemain kalah dari Bandar!';
  g.status = `Bandar: ${dBust ? 'BUST (' + dVal + ')' : dVal}. Permainan selesai.`;
}

// Strip secret cards from other players before sending to client
function sanitizeGameStateForPlayer(g, playerIdx) {
  if (!g) return null;
  const clone = JSON.parse(JSON.stringify(g));
  clone.turnStartedAt = g.turnStartedAt || Date.now();
  clone.turnTimeLimitSec = g.turnTimeLimitSec || 60;
  // Never send the live deck (or hidden bluff cards) in polling responses.
  // This also makes each game sync significantly smaller.
  if (!clone.finished) {
    delete clone.deck;
    if (clone.mode === 'bohong') {
      clone.pile = (clone.pile || []).map(() => ({ hidden: true }));
      if (clone.lastClaim) {
        clone.lastClaim = {
          by: clone.lastClaim.by,
          claimedRank: clone.lastClaim.claimedRank,
          count: clone.lastClaim.cards?.length || 0
        };
      }
    }
  }
  clone.players = clone.players.map((p, idx) => {
    if (idx === playerIdx || clone.finished) {
      return p;
    }
    return {
      ...p,
      handCount: p.hand.length,
      hand: p.hand.map(() => ({ hidden: true }))
    };
  });
  if (clone.mode === 'blackjack' && !clone.dealer.revealed) {
    clone.dealer = {
      revealed: false,
      hand: [clone.dealer.hand[0], { hidden: true }]
    };
  }
  return clone;
}

module.exports = {
  MINUMAN_RULES,
  calc41Score,
  bjValue,
  initGame,
  repairCapsaOpening,
  prepareGoFishTurn,
  processGameAction,
  sanitizeGameStateForPlayer,
};
