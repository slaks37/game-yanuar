const { SUITS, CAPSA_RANK_ORDER, capsaValue, sortCapsaHand } = require('./cards');

function isThreeOfDiamonds(card) {
  return card && card.rank === '3' && card.suit === '♦';
}

function capsaCheckStraight(cards) {
  if (cards.length !== 5) return null;
  const indices = cards.map(c => CAPSA_RANK_ORDER.indexOf(c.rank)).sort((a, b) => a - b);
  // Check standard consecutive
  let consecutive = true;
  for (let i = 0; i < 4; i++) {
    if (indices[i + 1] !== indices[i] + 1) {
      consecutive = false;
      break;
    }
  }
  if (consecutive) return indices[4];

  // Check A-2-3-4-5 wrap
  const ranks = cards.map(c => c.rank).sort();
  const a2345 = ['2', '3', '4', '5', 'A'];
  if (ranks.every((r, i) => r === a2345[i])) return CAPSA_RANK_ORDER.indexOf('5');

  return null;
}

function capsaEvaluateHand(cards) {
  if (!cards || !cards.length) return null;
  const n = cards.length;
  const sorted = sortCapsaHand(cards);

  if (n === 1) {
    const c = sorted[0];
    return { type: 'single', tier: 1, value: capsaValue(c), highCard: c, label: `Single ${c.rank}${c.suit}` };
  }

  if (n === 2) {
    if (sorted[0].rank === sorted[1].rank) {
      const high = sorted[1];
      return { type: 'pair', tier: 1, value: capsaValue(high), highCard: high, label: `Pair ${high.rank}` };
    }
    return null;
  }

  if (n === 3) {
    if (sorted[0].rank === sorted[1].rank && sorted[1].rank === sorted[2].rank) {
      const high = sorted[2];
      return { type: 'triple', tier: 1, value: capsaValue(high), highCard: high, label: `Triple ${high.rank}` };
    }
    return null;
  }

  if (n === 5) {
    const counts = {};
    sorted.forEach(c => { counts[c.rank] = (counts[c.rank] || 0) + 1; });
    const countVals = Object.values(counts).sort((a, b) => b - a);

    const isFlush = sorted.every(c => c.suit === sorted[0].suit);
    const straightHigh = capsaCheckStraight(sorted);

    // Straight Flush
    if (straightHigh !== null && isFlush) {
      const high = sorted[4];
      return { type: 'five', tier: 5, subtype: 'straight_flush', value: 5000 + capsaValue(high), highCard: high, label: `Straight Flush (${high.rank}${high.suit})` };
    }

    // Four of a Kind (Piting)
    if (countVals[0] === 4) {
      const fourRank = Object.keys(counts).find(r => counts[r] === 4);
      const val = CAPSA_RANK_ORDER.indexOf(fourRank);
      return { type: 'five', tier: 4, subtype: 'four_kind', value: 4000 + val, label: `4 of a Kind (${fourRank})` };
    }

    // Full House (Polo)
    if (countVals[0] === 3 && countVals[1] === 2) {
      const tripRank = Object.keys(counts).find(r => counts[r] === 3);
      const val = CAPSA_RANK_ORDER.indexOf(tripRank);
      return { type: 'five', tier: 3, subtype: 'full_house', value: 3000 + val, label: `Full House (${tripRank})` };
    }

    // Flush
    if (isFlush) {
      const sVal = SUITS.indexOf(sorted[0].suit);
      const high = sorted[4];
      return { type: 'five', tier: 2, subtype: 'flush', value: 2000 + sVal * 100 + capsaValue(high), highCard: high, label: `Flush ${sorted[0].suit}` };
    }

    // Straight
    if (straightHigh !== null) {
      const high = sorted[4];
      return { type: 'five', tier: 1, subtype: 'straight', value: 1000 + capsaValue(high), highCard: high, label: `Straight (${high.rank}${high.suit})` };
    }

    return null;
  }

  return null;
}

function capsaValidateSelection(cards, tablePlay, mustInclude3D = false) {
  if (mustInclude3D && !cards.some(isThreeOfDiamonds)) {
    return { ok: false, msg: 'Langkah pembuka wajib menyertakan 3♦ (3 Wajik)!' };
  }
  const evalNew = capsaEvaluateHand(cards);
  if (!evalNew) {
    return { ok: false, msg: 'Kombinasi kartu tidak sah! Pilih Single, Pair, Triple, atau 5 Kartu (Straight, Flush, Full House, 4 of a Kind).' };
  }

  if (!tablePlay) return { ok: true, evalNew };

  const evalOld = tablePlay.evaluation;
  if (evalNew.type !== evalOld.type) {
    return { ok: false, msg: `Harus mengeluarkan tipe yang sama (${evalOld.label})!` };
  }

  if (evalNew.type === 'five') {
    if (evalNew.tier < evalOld.tier) {
      return { ok: false, msg: `Kombinasi 5 kartu harus lebih tinggi dari ${evalOld.label}!` };
    }
    if (evalNew.tier === evalOld.tier && evalNew.value <= evalOld.value) {
      return { ok: false, msg: `Nilai kombinasi harus lebih tinggi dari ${evalOld.label}!` };
    }
    return { ok: true, evalNew };
  }

  if (evalNew.value <= evalOld.value) {
    return { ok: false, msg: `Kartu harus lebih tinggi dari ${evalOld.label}!` };
  }

  return { ok: true, evalNew };
}

function capsaFindAllFiveCombos(hand) {
  const combos = [];
  const n = hand.length;
  if (n < 5) return combos;

  for (let a = 0; a < n - 4; a++) {
    for (let b = a + 1; b < n - 3; b++) {
      for (let c = b + 1; c < n - 2; c++) {
        for (let d = c + 1; d < n - 1; d++) {
          for (let e = d + 1; e < n; e++) {
            const set = [hand[a], hand[b], hand[c], hand[d], hand[e]];
            const ev = capsaEvaluateHand(set);
            if (ev) combos.push({ cards: set, evaluation: ev });
          }
        }
      }
    }
  }
  return combos;
}

function capsaFindCombosByType(hand, type, must3D = false) {
  const sorted = sortCapsaHand(hand);
  const results = [];

  if (type === 'single') {
    for (const c of sorted) {
      if (!must3D || isThreeOfDiamonds(c)) {
        results.push({ cards: [c], evaluation: capsaEvaluateHand([c]) });
      }
    }
  } else if (type === 'pair') {
    for (let i = 0; i < sorted.length - 1; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        if (sorted[i].rank === sorted[j].rank) {
          const pair = [sorted[i], sorted[j]];
          if (!must3D || pair.some(isThreeOfDiamonds)) {
            results.push({ cards: pair, evaluation: capsaEvaluateHand(pair) });
          }
        }
      }
    }
  } else if (type === 'triple') {
    for (let i = 0; i < sorted.length - 2; i++) {
      for (let j = i + 1; j < sorted.length - 1; j++) {
        for (let k = j + 1; k < sorted.length; k++) {
          if (sorted[i].rank === sorted[j].rank && sorted[j].rank === sorted[k].rank) {
            const trip = [sorted[i], sorted[j], sorted[k]];
            if (!must3D || trip.some(isThreeOfDiamonds)) {
              results.push({ cards: trip, evaluation: capsaEvaluateHand(trip) });
            }
          }
        }
      }
    }
  } else if (type === 'five') {
    const all = capsaFindAllFiveCombos(sorted);
    for (const c of all) {
      if (!must3D || c.cards.some(isThreeOfDiamonds)) {
        results.push(c);
      }
    }
  }
  return results;
}

module.exports = {
  isThreeOfDiamonds,
  capsaEvaluateHand,
  capsaValidateSelection,
  capsaFindCombosByType,
};
