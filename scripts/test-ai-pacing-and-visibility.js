// No database required. Run: npm test
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { sanitizeGameStateForPlayer } = require('../lib/engine/games');

const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const clientSource = fs.readFileSync(path.join(__dirname, '..', 'public/js/app.js'), 'utf8');
const start = source.indexOf('function publicBotMove');
const end = source.indexOf('// Check and enforce 60s max turn timer', start);
assert(start >= 0 && end > start, 'Bot engine declarations are missing');
const botFunctions = source.slice(start, end);

const publicBotMove = new Function(botFunctions + '\nreturn publicBotMove;')();
const card = { id: '7D', rank: '7', suit: '♦' };

const capsa = publicBotMove(
  { mode: 'capsa', status: 'Next', lastAction: { by: 0, text: 'Single 7♦' } },
  { id: 0, name: 'Test Bot' },
  { action: 'play', payload: { cardIds: ['7D'] } }, [card]
);
assert.deepEqual(capsa.cards.map(c => c.rank + c.suit), ['7♦']);

const sevenup = publicBotMove(
  { mode: 'sevenup', status: 'Next', lastAction: { by: 0, text: '7♦' } },
  { id: 0, name: 'Test Bot' },
  { action: 'play', payload: { cardId: '7D' } }, [card]
);
assert.equal(sevenup.cards[0].rank, '7');

const bluff = publicBotMove(
  { mode: 'bohong', status: 'Bluff' },
  { id: 0, name: 'Test Bot' },
  { action: 'play', payload: { cardIds: ['7D'] } }, [card]
);
assert.equal(bluff.faceDownCount, 1);
assert.equal(bluff.cards.length, 0, 'Bluff cards must remain hidden');

const party = publicBotMove(
  { mode: 'minuman', status: 'Draw', currentRule: { card: '10♠' } },
  { id: 0, name: 'Test Bot' }, { action: 'draw', payload: {} }, []
);
assert.equal(party.cards[0].rank + party.cards[0].suit, '10♠');

const hiddenGame = {
  mode: 'bohong', players: [
    { id: 0, playerId: 'bot_0', hand: [card] },
    { id: 1, playerId: 'usr_1', hand: [{ id: 'AC', rank: 'A', suit: '♣' }] }
  ],
  deck: [card], pile: [card],
  lastClaim: { by: 0, cards: [card], claimedRank: '7', isBluff: true },
  finished: false, turnStartedAt: 123
};
const safe = sanitizeGameStateForPlayer(hiddenGame, 1);
assert(!('deck' in safe), 'Deck leaked through game sync');
assert(!('rank' in safe.pile[0]), 'Hidden pile leaked');
assert(!('cards' in safe.lastClaim), 'Bluff faces leaked');
assert(!('rank' in safe.players[0].hand[0]), 'Bot hand leaked');
assert.equal(safe.players[1].hand[0].rank, 'A', 'Own cards must remain visible');

// GET and /sync may read state and handle AFK timeouts, but cannot run AI.
const gameGetRoutes = source.slice(
  source.indexOf("app.get('/api/game/:roomId'"),
  source.indexOf("app.post('/api/game/:roomId/action'")
);
assert(!gameGetRoutes.includes('runBotTurnsIfNeeded('), 'Polling unexpectedly advances bot moves');
assert(clientSource.includes('ingestRoomEvents(res.events, res.latestEventId)'),
  'Client must replay every public bot move even on delta-only sync');

async function concurrentBotTest() {
  let version = 1;
  const events = [];
  const original = () => ({
    mode: 'sevenup', turn: 0, finished: false,
    turnStartedAt: Date.now() - 4000, status: 'Start',
    players: [
      { id: 0, playerId: 'bot_0', name: 'Bot', isBot: true, hand: [card] },
      { id: 1, playerId: 'usr_1', name: 'Human', isBot: false, hand: [] }
    ]
  });
  let stored = original();
  const query = async (sql, values) => {
    if (sql.startsWith('UPDATE game_states')) {
      if (values[2] !== version) return { rows: [] };
      stored = JSON.parse(values[0]);
      return { rows: [{ version: ++version }] };
    }
    if (sql.startsWith('SELECT state, version')) {
      return { rows: [{ state: stored, version }] };
    }
    throw new Error('Unexpected SQL: ' + sql);
  };
  const processGameAction = (game, seat) => {
    game.players[seat].hand = [];
    game.turn = 1;
    game.status = 'Bot plays 7♦';
    game.lastAction = { by: seat, text: '7♦' };
    game.turnStartedAt = Date.now();
    return { ok: true, g: game };
  };
  const makeRunner = new Function(
    'query', 'getBotDecision', 'processGameAction',
    'recordRoomEvent', 'triggerBotMoveReaction', 'handleGameOver',
    botFunctions + '\nreturn runBotTurnsIfNeeded;'
  );
  const run = makeRunner(
    query,
    () => ({ action: 'play', payload: { cardId: '7D' } }),
    processGameAction,
    async (_roomId, type, payload) => { events.push({ type, payload }); },
    async () => {}, async () => {}
  );
  const result = await Promise.all([run('room_1', original(), 1), run('room_1', original(), 1)]);
  assert.equal(version, 2, 'Two concurrent requests must commit exactly once');
  assert.equal(events.length, 1, 'Only one move event should be published');
  assert.equal(events[0].payload.move.cards[0].rank, '7');
  for (const item of result) {
    assert.equal(Number(item.version), 2);
    assert.equal(item.game.turn, 1);
  }
}

concurrentBotTest().then(() => {
  console.log('PASS: bot concurrency, public move replay, delta sync, hidden cards');
}).catch(err => { console.error(err); process.exitCode = 1; });
