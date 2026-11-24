const assert = require('node:assert/strict');
const test = require('node:test');
const { createDeck } = require('../lib/engine/cards');
const {
  initGame,
  processGameAction,
  repairCapsaOpening,
  sanitizeGameStateForPlayer
} = require('../lib/engine/games');

function makePlayers(count) {
  return Array.from({ length: count }, (_, index) => ({
    id: `player_${index}`,
    name: `Pemain ${index + 1}`
  }));
}

function card(rank, suit) {
  return { id: `${rank}${suit}`, rank, suit };
}

function isOpeningCard(value) {
  return value.rank === '3' && value.suit === '♦';
}

function shuffleOpeningCardToEnd(callback) {
  const originalRandom = Math.random;
  let swaps = 0;
  // Swap the third unshuffled card, 3♦, into the last slot without moving the rest.
  Math.random = () => swaps++ === 0 ? 2.5 / 52 : 0.999999;
  try {
    return callback();
  } finally {
    Math.random = originalRandom;
  }
}

test('Capsa deals 3♦ even when it shuffles into the undealt cards', () => {
  const deck = shuffleOpeningCardToEnd(createDeck);
  assert.equal(deck.findIndex(isOpeningCard), 51);
  const game = shuffleOpeningCardToEnd(() => initGame('capsa', makePlayers(8)));
  const starter = game.players[game.turn];
  const opener = starter.hand.find(isOpeningCard);

  assert.deepEqual(game.players.map(player => player.hand.length), Array(8).fill(6));
  assert.ok(opener, 'The opening player must hold 3♦');
  assert.equal(game.mustInclude3D, true);
  assert.equal(processGameAction(game, game.turn, 'play', { cardIds: [opener.id] }).ok, true);
  assert.equal(game.mustInclude3D, false);
});

test('an old Capsa state with no 3♦ can open after repair', () => {
  const game = shuffleOpeningCardToEnd(() => initGame('capsa', makePlayers(8)));
  const active = game.players[game.turn];
  active.hand = active.hand.filter(card => !isOpeningCard(card));
  const selection = { cardIds: [active.hand[0].id] };

  assert.equal(processGameAction(game, game.turn, 'play', selection).ok, false);
  repairCapsaOpening(game);
  assert.equal(game.mustInclude3D, false);
  assert.equal(processGameAction(game, game.turn, 'play', selection).ok, true);
});

test('Seven Up deals all 52 unique cards for every supported table size', () => {
  for (let count = 2; count <= 8; count++) {
    const game = initGame('sevenup', makePlayers(count));
    const hands = game.players.map(player => player.hand);
    const cards = hands.flat();
    const sizes = hands.map(hand => hand.length);

    assert.equal(cards.length, 52, `Table size ${count}`);
    assert.equal(new Set(cards.map(card => card.id)).size, 52);
    assert.equal(new Set(cards.filter(card => card.rank === '7').map(card => card.suit)).size, 4);
    assert.ok(Math.max(...sizes) - Math.min(...sizes) <= 1);
  }
});

function goFishGame(hands, stock) {
  const game = initGame('gofish', makePlayers(hands.length));
  for (const [index, hand] of hands.entries()) {
    game.players[index].hand = hand;
    game.players[index].books = 0;
  }
  game.turn = 0;
  game.deck = stock;
  return game;
}

test('Go Fish refills the next empty hand when cards remain', () => {
  const refill = card('Q', '♣');
  const game = goFishGame([[card('7', '♦')], [], [card('K', '♦')]], [refill, card('10', '♠')]);

  assert.equal(processGameAction(game, 0, 'ask', { targetIdx: 2, rank: '7' }).ok, true);
  assert.equal(game.turn, 1);
  assert.deepEqual(game.players[1].hand, [refill]);
  assert.equal(game.deck.length, 0);
  assert.equal(game.finished, false);
});

test('Go Fish skips the next empty hand when the last stock card was drawn', () => {
  const game = goFishGame([[card('7', '♦')], [], [card('K', '♦')]], [card('Q', '♣')]);

  assert.equal(processGameAction(game, 0, 'ask', { targetIdx: 2, rank: '7' }).ok, true);
  assert.equal(game.turn, 2);
  assert.equal(game.players[1].hand.length, 0);
  assert.equal(game.finished, false);
});

test('Go Fish awards the last book and finishes when no cards remain', () => {
  const game = goFishGame([[card('7', '♦')], [card('7', '♣'), card('7', '♥'), card('7', '♠')], []], []);
  game.players[0].books = 6;
  game.players[1].books = 6;

  assert.equal(processGameAction(game, 0, 'ask', { targetIdx: 1, rank: '7' }).ok, true);
  assert.equal(game.players[0].books, 7);
  assert.ok(game.players.every(player => player.hand.length === 0));
  assert.equal(game.finished, true);
  assert.equal(game.winnerIdx, 0);
});

test('private hands, the bluff pile, and the dealer hole card have no public IDs', () => {
  const bluff = initGame('bohong', makePlayers(2));
  const claimed = bluff.players[0].hand[0];
  assert.equal(processGameAction(bluff, 0, 'play', { cardIds: [claimed.id] }).ok, true);
  const gameView = sanitizeGameStateForPlayer(bluff, 1);

  assert.deepEqual(gameView.players[0].hand, bluff.players[0].hand.map(() => ({ hidden: true })));
  assert.deepEqual(gameView.pile, [{ hidden: true }]);
  assert.deepEqual(gameView.lastClaim, { by: 0, claimedRank: 'A', count: 1 });
  assert.deepEqual(gameView.players[1].hand, bluff.players[1].hand);
  assert.equal(bluff.pile[0].id, claimed.id, 'Sanitization must preserve authoritative cards');

  const blackjack = initGame('blackjack', makePlayers(2));
  const blackjackView = sanitizeGameStateForPlayer(blackjack, 0);
  assert.deepEqual(blackjackView.dealer.hand, [blackjack.dealer.hand[0], { hidden: true }]);
  assert.deepEqual(blackjackView.players[1].hand, [{ hidden: true }, { hidden: true }]);
  assert.equal(Object.hasOwn(blackjackView, 'deck'), false);
});

test('Setan rejects out-of-range and non-integer indices without changing either hand', () => {
  const game = initGame('setan', makePlayers(2));
  game.turn = 0;
  game.finished = false;
  game.players[0].hand = [card('A', '♦')];
  game.players[1].hand = [card('2', '♣'), card('3', '♥')];
  const original = structuredClone(game);

  for (const cardIndex of [-1, 2, 0.5, 'invalid', undefined]) {
    assert.equal(processGameAction(game, 0, 'draw', { cardIndex }).ok, false);
    assert.deepEqual(game, original);
  }
});

test('Bluff rejects empty, oversized, duplicate, foreign, and malformed card selections', () => {
  const game = initGame('bohong', makePlayers(2));
  const [first] = game.players[0].hand;
  const original = structuredClone(game);

  for (const cardIds of [
    [],
    game.players[0].hand.slice(0, 4).map(card => card.id),
    [first.id, first.id],
    [game.players[1].hand[0].id],
    first.id
  ]) {
    assert.equal(processGameAction(game, 0, 'play', { cardIds }).ok, false);
    assert.deepEqual(game, original);
  }
});
