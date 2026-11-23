const { sortCapsaHand, rankNum, RANKS } = require('./cards');
const { capsaFindCombosByType, capsaValidateSelection } = require('./capsa');
const { calc41Score, bjValue } = require('./games');

function getBotDecision(g, botIdx) {
  const p = g.players[botIdx];
  if (!p || g.finished || g.turn !== botIdx) return null;

  // 1. CAPSA
  if (g.mode === 'capsa') {
    if (!g.tablePlay) {
      // Must start with 3D if needed
      const tryOrder = ['five', 'triple', 'pair', 'single'];
      for (const t of tryOrder) {
        const found = capsaFindCombosByType(p.hand, t, g.mustInclude3D);
        if (found.length) {
          return { action: 'play', payload: { cardIds: found[0].cards.map(c => c.id) } };
        }
      }
      return { action: 'play', payload: { cardIds: [p.hand[0].id] } };
    }

    const type = g.tablePlay.evaluation.type;
    const candidates = capsaFindCombosByType(p.hand, type, false);
    for (const c of candidates) {
      const chk = capsaValidateSelection(c.cards, g.tablePlay, false);
      if (chk.ok) {
        return { action: 'play', payload: { cardIds: c.cards.map(x => x.id) } };
      }
    }
    return { action: 'pass', payload: {} };
  }

  // 2. SETAN-SETAN
  if (g.mode === 'setan') {
    // Find previous active player
    let prevIdx = -1;
    const n = g.players.length;
    for (let step = 1; step < n; step++) {
      const idx = (botIdx - step + n) % n;
      if (g.players[idx].hand.length > 0) {
        prevIdx = idx;
        break;
      }
    }
    if (prevIdx !== -1) {
      const target = g.players[prevIdx];
      const pickIdx = Math.floor(Math.random() * target.hand.length);
      return { action: 'draw', payload: { cardIndex: pickIdx } };
    }
  }

  // 3. SEVEN UP
  if (g.mode === 'sevenup') {
    const playables = p.hand.filter(c => {
      const lane = g.board[c.suit];
      const num = rankNum(c.rank);
      if (!lane) return num === 7;
      return num === lane.low - 1 || num === lane.high + 1;
    });
    if (playables.length) {
      return { action: 'play', payload: { cardId: playables[0].id } };
    }
    return { action: 'pass', payload: {} };
  }

  // 4. GO FISH
  if (g.mode === 'gofish') {
    if (!p.hand.length) return null;
    const targets = g.players.filter(pl => pl.id !== botIdx && pl.hand.length > 0);
    if (!targets.length) return null;
    const target = targets[Math.floor(Math.random() * targets.length)];
    const myRanks = [...new Set(p.hand.map(c => c.rank))];
    const rank = myRanks[Math.floor(Math.random() * myRanks.length)];
    return { action: 'ask', payload: { targetIdx: target.id, rank } };
  }

  // 5. BOHONG-BOHONGAN
  if (g.mode === 'bohong') {
    const targetRank = RANKS[g.targetRankIdx];
    const matching = p.hand.filter(c => c.rank === targetRank);
    if (matching.length) {
      const count = Math.min(matching.length, 2);
      return { action: 'play', payload: { cardIds: matching.slice(0, count).map(c => c.id) } };
    }
    // Bluff with lowest cards
    const bluffCards = p.hand.slice(0, Math.min(2, p.hand.length));
    return { action: 'play', payload: { cardIds: bluffCards.map(c => c.id) } };
  }

  // 6. 4-1
  if (g.mode === 'empatsatu') {
    if (g.phase === 'draw') {
      const score = calc41Score(p.hand);
      if (score >= 38) {
        return { action: 'knock', payload: {} };
      }
      return { action: 'draw', payload: { source: 'deck' } };
    }
    if (g.phase === 'discard') {
      // Find suit with most points, discard card of different suit
      const suitCounts = { '♦': 0, '♣': 0, '♥': 0, '♠': 0 };
      p.hand.forEach(c => { suitCounts[c.suit] = (suitCounts[c.suit] || 0) + 1; });
      const bestSuit = Object.keys(suitCounts).sort((a, b) => suitCounts[b] - suitCounts[a])[0];
      const discardCandidate = p.hand.find(c => c.suit !== bestSuit) || p.hand[0];
      return { action: 'discard', payload: { cardId: discardCandidate.id } };
    }
  }

  // 7. MINUMAN
  if (g.mode === 'minuman') {
    return { action: 'draw', payload: {} };
  }

  // 8. BLACKJACK
  if (g.mode === 'blackjack') {
    const val = bjValue(p.hand);
    if (val < 16) {
      return { action: 'hit', payload: {} };
    }
    return { action: 'stand', payload: {} };
  }

  return null;
}

module.exports = {
  getBotDecision,
};
