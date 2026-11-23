const SUITS = ['♦', '♣', '♥', '♠'];
const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
const CAPSA_RANK_ORDER = ['3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A', '2'];

function createDeck(numDecks = 1, withJoker = false) {
  const deck = [];
  let uid = 1;
  for (let d = 0; d < numDecks; d++) {
    for (const suit of SUITS) {
      for (const rank of RANKS) {
        deck.push({ id: `c_${d}_${suit}_${rank}_${uid++}`, rank, suit, isJoker: false });
      }
    }
  }
  if (withJoker) {
    deck.push({ id: `c_joker_${uid++}`, rank: 'SETAN', suit: '👹', isJoker: true });
  }
  return shuffle(deck);
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function isRedSuit(suit) {
  return suit === '♥' || suit === '♦';
}

function capsaValue(card) {
  if (!card) return -1;
  const rIdx = CAPSA_RANK_ORDER.indexOf(card.rank);
  const sIdx = SUITS.indexOf(card.suit);
  return rIdx * 4 + sIdx;
}

function sortCapsaHand(hand) {
  return [...hand].sort((a, b) => capsaValue(a) - capsaValue(b));
}

function rankNum(rank) {
  return RANKS.indexOf(rank) + 1;
}

module.exports = {
  SUITS,
  RANKS,
  CAPSA_RANK_ORDER,
  createDeck,
  shuffle,
  isRedSuit,
  capsaValue,
  sortCapsaHand,
  rankNum,
};
