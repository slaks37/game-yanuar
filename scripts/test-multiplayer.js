// Run after npm run init-db against a disposable PostgreSQL database.
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { once } = require('node:events');
const test = require('node:test');
const app = require('../server');
const { pool, query } = require('../lib/db');
const { calc41Score } = require('../lib/engine/games');

test('multiplayer rooms and turns stay consistent across independent clients', async () => {
  const nonce = randomUUID().slice(0, 8);
  const host = `test_host_${nonce}`;
  const guest = `test_guest_${nonce}`;
  const third = `test_third_${nonce}`;
  const fourth = `test_fourth_${nonce}`;
  const outsider = `test_outsider_${nonce}`;
  const players = [host, guest, third, fourth, outsider];
  const createdRooms = [];
  const server = app.listen(0, '127.0.0.1');

  try {
    await once(server, 'listening');
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    async function request(path, body) {
      const response = await fetch(baseUrl + path, body === undefined ? undefined : {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      return { status: response.status, data: await response.json() };
    }

    async function ok(path, body) {
      const response = await request(path, body);
      assert.equal(response.status, 200, `${path}: ${JSON.stringify(response.data)}`);
      assert.equal(response.data.ok, true, path);
      return response.data;
    }

    async function createRoom(mode, options = {}) {
      const { room } = await ok('/api/rooms', {
        name: `Test ${nonce}`, hostId: host, mode, maxPlayers: 4, ...options
      });
      createdRooms.push(room.id);
      return room;
    }

    await Promise.all(players.map(id => ok('/api/player/sync', { id, name: 'Nama Sama' })));
    const room = await createRoom('empatsatu');
    const roomPath = `/api/rooms/${room.id}`;
    const gamePath = `/api/game/${room.id}`;
    const joinPath = `/api/rooms/${room.code}/join`;
    const [j1, j2, j3, j4] = await Promise.all([
      ok(joinPath, { playerId: guest }),
      ok(joinPath, { playerId: third }),
      ok(joinPath, { playerId: fourth }),
      ok(joinPath, { playerId: guest })
    ]);
    assert.equal(j1.seat, j4.seat, 'a second request by the same player must preserve their seat');
    assert.deepEqual([j1.seat, j2.seat, j3.seat].sort((a, b) => a - b), [1, 2, 3]);

    await ok(`${roomPath}/ready`, { playerId: guest, isReady: true });
    const lounge = await ok(`${roomPath}/sync?since=0`);
    assert.equal(lounge.players.filter(player => player.name === 'Nama Sama').length, 4);
    assert.equal(lounge.players.find(player => player.id === guest).is_ready, true);

    await Promise.all([ok(`${roomPath}/start`, { hostId: host }), ok(`${roomPath}/start`, { hostId: host })]);
    const started = await ok(`${gamePath}?playerId=${host}`);
    assert.equal(started.version, 1, 'parallel start requests must deal exactly once');
    assert.equal(started.game.turn, 0);
    assert.equal(started.game.players.length, 4);
    assert.equal(started.game.players[0].hand.length, 4);
    assert.deepEqual(started.game.players[1].hand, Array.from({ length: 4 }, () => ({ hidden: true })));
    const outsiderAction = await request(`${gamePath}/action`, {
      playerId: outsider, action: 'draw', payload: { source: 'deck' }, version: started.version
    });
    assert.equal(outsiderAction.status, 403);

    const draw = { playerId: host, action: 'draw', payload: { source: 'deck' }, version: started.version };
    const draws = await Promise.all([request(`${gamePath}/action`, draw), request(`${gamePath}/action`, draw)]);
    assert.deepEqual(draws.map(response => response.status).sort((a, b) => a - b), [200, 409]);
    const afterDraw = draws.find(response => response.status === 200).data;
    assert.equal(afterDraw.version, 2);
    assert.equal(afterDraw.game.players[0].hand.length, 5);
    assert.equal(afterDraw.game.turn, 0);
    assert.equal(afterDraw.game.phase, 'discard');

    const drawnHand = afterDraw.game.players[0].hand;
    const discardable = drawnHand.find(card => calc41Score(drawnHand.filter(c => c.id !== card.id)) < 41);
    assert.ok(discardable, 'the test needs a discard that does not immediately end the round');
    const cardId = discardable.id;
    const discard = { playerId: host, action: 'discard', payload: { cardId }, version: started.version };
    const staleDiscard = await request(`${gamePath}/action`, discard);
    assert.equal(staleDiscard.status, 409, 'an old version must be rejected even when the turn still belongs to the requester');
    const updated = await ok(`${gamePath}/action`, { ...discard, version: afterDraw.version });
    assert.equal(updated.version, 3);
    assert.equal(updated.game.players[0].hand.length, 4);
    assert.equal(updated.game.turn, 1);

    const msg = `Halo dari host ${nonce}`;
    const chatPath = `/api/events/${room.id}/chat`;
    assert.equal((await request(chatPath, { playerId: outsider, message: 'Outside room' })).status, 403);
    await ok(chatPath, { playerId: host, message: msg });
    const guestSync = await ok(`${gamePath}/sync?version=1&since=${lounge.latestEventId}&playerId=${guest}`);
    assert.equal(guestSync.version, updated.version);
    assert.equal(guestSync.game.turn, updated.game.turn);
    assert.equal(guestSync.mySeat, j1.seat);
    assert.deepEqual(guestSync.events.filter(event => event.event_type === 'CHAT').map(event => event.payload.message), [msg]);
    assert.equal(guestSync.events.filter(event => event.event_type === 'GAME_START').length, 1);
    const unchanged = await ok(`${gamePath}/sync?version=${guestSync.version}&since=${guestSync.latestEventId}&playerId=${guest}`);
    assert.equal(unchanged.game, null);
    assert.deepEqual(unchanged.events, []);

    await ok(`${roomPath}/start`, { hostId: host });
    const lateStart = await ok(`${gamePath}?playerId=${host}`);
    assert.equal(lateStart.version, updated.version, 'a late start must preserve the live match');
    assert.equal(lateStart.game.turn, updated.game.turn);
    await ok(`${roomPath}/leave`, { playerId: guest });
    const rejoin = await ok(joinPath, { playerId: guest });
    assert.equal(rejoin.reconnected, true);
    assert.equal(rejoin.seat, j1.seat);
    assert.equal((await ok(`${gamePath}?playerId=${guest}`)).version, updated.version);
    const newIdentity = await request(joinPath, { playerId: outsider });
    assert.equal(newIdentity.status, 409, 'a new player with the same display name cannot replace a seated player');

    const activeId = updated.game.players[updated.game.turn].playerId;
    const finished = await ok(`${gamePath}/action`, { playerId: activeId, action: 'knock', version: updated.version });
    assert.equal(finished.game.finished, true);
    await ok(`${roomPath}/start`, { hostId: host, version: finished.version });
    const rematch = await ok(`${gamePath}?playerId=${host}`);
    assert.equal(rematch.version, finished.version + 1);
    assert.equal(rematch.game.finished, false);
    assert.equal(rematch.game.turn, 0);

    await ok(`${roomPath}/delete`, { playerId: host });
    assert.equal((await request(`${roomPath}/sync?since=0`)).status, 404);
    assert.equal((await request(`${gamePath}/sync?playerId=${guest}`)).status, 404);

    const password = 'sample-room-password';
    const privateRoom = await createRoom('capsa', { isPrivate: true, password });
    const privateJoinPath = `/api/rooms/${privateRoom.code}/join`;
    const locked = await request(privateJoinPath, { playerId: guest });
    assert.equal(locked.status, 403);
    assert.equal(locked.data.code, 'ROOM_PASSWORD_REQUIRED');
    const wrong = await request(privateJoinPath, { playerId: guest, password: 'incorrect' });
    assert.equal(wrong.status, 403);
    assert.equal(wrong.data.code, 'ROOM_PASSWORD_REQUIRED');
    const admitted = await ok(privateJoinPath, { playerId: guest, password });
    assert.equal(admitted.seat, 1);
    assert.ok(!Object.hasOwn(admitted.room, 'password'));
    const privateSyncPath = `/api/rooms/${privateRoom.id}/sync?since=0`;
    assert.equal((await request(privateSyncPath)).status, 403);
    const privateLounge = await ok(`${privateSyncPath}&playerId=${guest}`);
    assert.equal(privateLounge.events.some(event => event.event_type === 'CHAT'), false);
  } finally {
    try {
      if (createdRooms.length) {
        await query('DELETE FROM rooms WHERE id = ANY($1)', [createdRooms]);
        await query('DELETE FROM room_events WHERE room_id = ANY($1)', [createdRooms]);
      }
      await query('DELETE FROM players WHERE id = ANY($1)', [players]);
    } finally {
      await new Promise(resolve => server.close(resolve));
      await pool.end();
    }
  }
});
