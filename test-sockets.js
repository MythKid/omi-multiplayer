// Socket integration tests: tables (isolation, locking, leaving, rematch),
// duplicate joins, invalid packets, reconnect (reclaiming a seat with a
// session token), and lobby cleanup. Spawns a real server on a test port and
// drives it with real socket.io clients.
const { spawn } = require('child_process');
const { io } = require('socket.io-client');

const PORT = 3991;
const URL = 'http://127.0.0.1:' + PORT;
const PROTOCOL = 2;
let failures = 0;
const ok = (c, m) => { console.log((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) failures++; };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function connect(opts) {
  const o = Object.assign({ transports: ['websocket'], reconnection: false }, opts || {});
  o.auth = Object.assign({ v: PROTOCOL }, o.auth || {});
  return io(URL, o);
}
function waitEvent(sock, event, ms) {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), ms || 3000);
    sock.once(event, (d) => { clearTimeout(t); resolve(d === undefined ? {} : d); });
  });
}
// Resolve with the first `event` payload that satisfies `pred`.
function waitFor(sock, event, pred, ms) {
  return new Promise((resolve) => {
    const handler = (d) => { if (pred(d)) { clearTimeout(t); sock.off(event, handler); resolve(d); } };
    const t = setTimeout(() => { sock.off(event, handler); resolve(null); }, ms || 3000);
    sock.on(event, handler);
  });
}
// Connect and sit at a table; resolves { sock, token, lobby }.
async function sit(tableId, name) {
  const sock = connect();
  await waitEvent(sock, 'connect');
  const sessionP = waitEvent(sock, 'session');
  const lobbyP = waitEvent(sock, 'lobby-update');
  sock.emit('join-table', { tableId, name });
  const session = await sessionP;
  const lobby = await lobbyP;
  return { sock, token: session && session.token, lobby };
}

let server;
function startServer(extraEnv) {
  return new Promise((resolve, reject) => {
    server = spawn(process.execPath, ['server.js'], {
      cwd: __dirname,
      env: Object.assign({}, process.env, {
        PORT: String(PORT), LOG_LEVEL: 'error', MAX_SLOTS: '3', MAX_SOCKETS: '',
      }, extraEnv || {}),
    });
    let buf = '';
    const t = setTimeout(() => reject(new Error('server did not start')), 8000);
    server.stdout.on('data', (d) => {
      buf += d.toString();
      if (/running|listening/i.test(buf)) { clearTimeout(t); resolve(); }
    });
    server.stderr.on('data', () => {});
  });
}

async function run() {
  console.log('socket integration tests\n');
  await startServer();

  // --- the tables screen ---
  const viewer = connect();
  await waitEvent(viewer, 'connect');
  const listP = waitEvent(viewer, 'tables');
  viewer.emit('browse');
  const list = await listP;
  ok(Array.isArray(list) && list.length === 3, 'browse lists every table (' + (list && list.length) + ')');
  ok(list && list.every(t => t.status === 'empty' && t.canJoin), 'all tables start empty and joinable');

  // --- duplicate join on one socket keeps a single seat ---
  const a = await sit(1, 'Alice');
  ok(a.lobby && a.lobby.players.length === 1 && a.lobby.tableId === 1, 'first join seats one player at table 1');
  const dupErr = waitEvent(a.sock, 'join-error', 1000);
  a.sock.emit('join-table', { tableId: 2, name: 'AliceAgain' });
  ok(!!(await dupErr), 'a seated socket cannot take a second seat');
  const pushed = await waitFor(viewer, 'tables', l => l[0].humans === 1, 2000);
  ok(!!pushed, 'the tables screen updates when someone sits down');

  // --- names are unique within a table ---
  const twin = connect();
  await waitEvent(twin, 'connect');
  const twinErr = waitEvent(twin, 'join-error', 1500);
  twin.emit('join-table', { tableId: 1, name: 'ALICE' });
  ok(!!(await twinErr), 'a name already used at the table is refused (case-insensitive)');
  twin.close();

  // --- malformed packets do not crash the server ---
  a.sock.emit('set-mode', { mode: 'banana' });
  a.sock.emit('set-teams', { pairing: {} });
  a.sock.emit('play-card', { cardIndex: 99999 });
  a.sock.emit('shuffle-done', { entropy: 'nope', ops: 42 });
  a.sock.emit('vote-end', { action: 12345 });
  a.sock.emit('kapothi-call', {});
  a.sock.emit('choose-trump', { suit: '<script>' });
  a.sock.emit('cut-done', { segments: 'nope' });
  a.sock.emit('join-table', null);
  a.sock.emit('join-table', { tableId: 'x', name: {} });
  a.sock.emit('results-choice', 'junk');
  await wait(400);
  const probe = connect();
  ok(!!(await waitEvent(probe, 'connect')), 'server survives malformed packets and still accepts connections');
  probe.close();

  // --- leaving a lobby frees the seat and returns to the tables screen ---
  const leftP = waitEvent(a.sock, 'table-left');
  a.sock.emit('leave-table');
  ok(!!(await leftP), 'leave-table releases the seat');
  a.sock.close();
  await wait(200);

  // --- two tables run side by side, isolated ---
  const h1 = await sit(1, 'Host1');
  const p1 = await sit(1, 'Guest1');
  const h2 = await sit(2, 'Host2');
  ok(h1.token && h2.token, 'each player gets a session token');

  h1.sock.emit('set-mode', { mode: 4 });
  await wait(150);
  const g1 = waitEvent(h1.sock, 'state-update', 4000);
  h1.sock.emit('host-start');
  const gs1 = await g1;
  ok(gs1 && gs1.phase === 'shuffle' && gs1.tableId === 1, 'table 1 starts its own game');

  const locked = await waitFor(viewer, 'tables', l => l[0].status === 'playing', 2000);
  ok(locked && !locked[0].canJoin && locked[1].canJoin, 'a playing table is locked; others stay open');

  // A newcomer cannot join the running table, but can join another.
  const late = connect();
  await waitEvent(late, 'connect');
  const lateErr = waitEvent(late, 'join-error', 1500);
  late.emit('join-table', { tableId: 1, name: 'Latecomer' });
  ok(!!(await lateErr), 'joining a table whose game has started is refused');
  const lateLobby = waitEvent(late, 'lobby-update', 1500);
  late.emit('join-table', { tableId: 3, name: 'Latecomer' });
  ok(!!(await lateLobby), 'the same player can still join an open table');
  late.close();

  // Shuffle relays stay inside their table.
  const dealerSock = gs1.dealer === gs1.mySeat ? h1.sock : p1.sock;
  const watcher1 = dealerSock === h1.sock ? p1.sock : h1.sock;
  const seenAtTable1 = waitEvent(watcher1, 'shuffle-move', 1500);
  const leakedToTable2 = waitEvent(h2.sock, 'shuffle-move', 1500);
  dealerSock.emit('shuffle-move', { x: 0.5, y: 0.5 });
  ok(!!(await seenAtTable1), 'a wash move reaches the other players at the table');
  ok(!(await leakedToTable2), 'a wash move never reaches another table');

  // Table 2 runs its own game at the same time.
  const g2 = waitEvent(h2.sock, 'state-update', 4000);
  h2.sock.emit('host-start');
  const gs2 = await g2;
  ok(gs2 && gs2.tableId === 2 && gs2.mode === 4, 'table 2 runs a separate game concurrently');

  // --- reconnect: reclaim a seat with the session token, at the right table ---
  h1.sock.disconnect();
  await wait(400); // well within the grace window
  const resumed = connect({ auth: { token: h1.token } });
  const back = await waitEvent(resumed, 'state-update', 4000);
  ok(back && back.tableId === 1 && back.mySeat === gs1.mySeat, 'reconnect with the token restores the seat at table 1');

  // A stale token is told to start fresh.
  const stale = connect({ auth: { token: 'not-a-real-token' } });
  ok(!!(await waitEvent(stale, 'session-invalid', 2000)), 'an unknown token gets session-invalid');
  stale.close();

  // An outdated client is told to reload.
  const old = io(URL, { transports: ['websocket'], reconnection: false, auth: { v: 1 } });
  ok(!!(await waitEvent(old, 'version-mismatch', 2000)), 'a client on another protocol version is told to reload');
  old.close();

  // --- the end-match vote, then the results screen and a rematch ---
  resumed.emit('vote-end', { action: 'propose' });
  await wait(200);
  p1.sock.emit('vote-end', { action: 'agree' });
  const over = await waitFor(resumed, 'state-update', d => d.gameOver, 3000);
  ok(over && over.gameOver && over.results, 'unanimous end-match vote finishes the game with a results screen');

  const finishing = await waitFor(viewer, 'tables', l => l[0].status === 'finished', 2000);
  ok(finishing && !finishing[0].canJoin, 'a finished table stays locked while results show');

  const rematchLobby = waitEvent(resumed, 'lobby-update', 3000);
  const guestLeft = waitEvent(p1.sock, 'table-left', 3000);
  resumed.emit('results-choice', { choice: 'stay' });
  p1.sock.emit('results-choice', { choice: 'leave' });
  ok(!!(await guestLeft), 'choosing to leave sends that player back to the tables screen');
  const rl = await rematchLobby;
  ok(rl && rl.players.length === 1 && rl.isHost, 'choosing to stay returns the player to the table lobby');

  // --- a player leaving mid-game ends it for that table only ---
  const g3 = waitEvent(resumed, 'state-update', 4000);
  resumed.emit('host-start');
  await g3;
  const t2Before = await waitFor(viewer, 'tables', l => l[0].status === 'playing', 2000);
  ok(!!t2Before, 'a rematch can start at the same table');
  const left = waitEvent(resumed, 'table-left', 2000);
  resumed.emit('leave-table');
  ok(!!(await left), 'leaving mid-game releases the player');
  const freed = await waitFor(viewer, 'tables', l => l[0].status === 'empty', 2000);
  ok(freed && freed[1].status === 'playing', 'table 1 is freed while table 2 keeps playing');

  resumed.close();
  p1.sock.close();
  h2.sock.close();
  await wait(400);

  // --- lobby cleanup: after everyone left, a fresh client is host at seat 0 ---
  // (table 3: its last player left from the lobby; table 2 is still holding
  // its dropped host's seat for the reconnect window.)
  const fresh = await sit(3, 'Newcomer');
  ok(fresh.lobby && fresh.lobby.players.length === 1 && fresh.lobby.isHost && fresh.lobby.yourSeat === 0,
    'table is clean after everyone left: newcomer becomes host at seat 0');
  fresh.sock.close();
  viewer.close();

  // --- partner wait: the trump caller's partner sees no cards until trump ---
  const four = [];
  for (const n of ['North', 'East', 'South', 'West']) four.push(await sit(3, n));
  const stateOf = four.map(() => null);
  four.forEach((p, i) => p.sock.on('state-update', (d) => { stateOf[i] = d; }));
  const started = waitEvent(four[0].sock, 'state-update', 4000);
  four[0].sock.emit('host-start');
  const st0 = await started;
  ok(st0 && st0.dealer === 0 && st0.trumpCallerSeat === 1 && st0.breakerSeat === 3,
    'four humans: seat 0 deals, seat 1 calls trump, seat 3 cuts');
  // Seat 0 washes for the minimum time, then offers the deck.
  for (let i = 0; i < 6; i++) { four[0].sock.emit('shuffle-move', { x: Math.random(), y: Math.random() }); await wait(60); }
  await wait(2500);
  const entropy = Array.from({ length: 64 }, () => Math.floor(Math.random() * 1e6));
  four[0].sock.emit('shuffle-done', { entropy, washMs: 2600, ops: [{ t: 'r' }, { t: 'r' }] });
  const cutPhase = await waitFor(four[3].sock, 'state-update', d => d.phase === 'cut', 3000);
  ok(!!cutPhase, 'the shuffle moves the game to the cut');
  four[3].sock.emit('cut-done', { segments: [[12, 32], [0, 12]] });
  const trumpPhase = await waitFor(four[1].sock, 'state-update', d => d.phase === 'trump', 8000);
  await wait(150);
  ok(!!trumpPhase, 'after the first deal the caller chooses trump');
  const partner = stateOf[3];
  ok(partner && partner.phase === 'trump' && partner.myHand.length === 0 && partner.myHandLocked === 4,
    'the partner of the caller receives no cards, only a locked count of 4');
  ok(stateOf[1] && stateOf[1].myHand.length === 4 && stateOf[1].myHandLocked === 0, 'the caller sees their 4 cards');
  ok(stateOf[0] && stateOf[0].myHand.length === 4 && stateOf[2] && stateOf[2].myHand.length === 4,
    'both opponents see their own 4 cards before trump');

  // A reconnect during the wait must not reveal the partner's hand either.
  four[3].sock.disconnect();
  await wait(300);
  const partnerBack = connect({ auth: { token: four[3].token } });
  const pb = await waitEvent(partnerBack, 'state-update', 3000);
  ok(pb && pb.phase === 'trump' && pb.myHand.length === 0 && pb.myHandLocked === 4,
    'reconnecting during the trump call still hides the partner hand');

  const unlocked = waitFor(partnerBack, 'state-update', d => d.phase !== 'trump', 3000);
  four[1].sock.emit('choose-trump', { suit: '♠' });
  const after = await unlocked;
  ok(after && after.myHand.length === 4 && after.myHandLocked === 0 && after.trump === '♠',
    'the partner hand unlocks the moment trump is called');
  partnerBack.close();
  four.forEach(p => p.sock.close());
  await wait(300);

  // --- idle reaper (on a server with very short idle timeouts) ---
  server.kill();
  await wait(400);
  await startServer({ GAME_IDLE_MIN: '0.05', LOBBY_IDLE_MIN: '0.05' }); // 3 s each

  const idleLobby = await sit(1, 'Sleepy');
  const lobbyClosed = await waitEvent(idleLobby.sock, 'table-left', 6000);
  ok(lobbyClosed && /closed/i.test(lobbyClosed.notice || ''), 'an idle lobby is closed and its players are told why');
  idleLobby.sock.close();

  const afk = await sit(2, 'Afk');
  const afkStart = waitEvent(afk.sock, 'state-update', 3000);
  afk.sock.emit('host-start');
  const afkState = await afkStart;
  ok(afkState && afkState.phase === 'shuffle' && afkState.dealer === afkState.mySeat,
    'the solo human deals first, so the game waits on them');
  const warned = await waitEvent(afk.sock, 'table-notice', 6000);
  ok(!!warned, 'an idle player is warned before the game ends');
  const kicked = await waitEvent(afk.sock, 'table-left', 6000);
  ok(kicked && /idle/i.test(kicked.notice || ''), 'an idle player is removed and the game ends');
  afk.sock.close();

  console.log('\n' + (failures === 0 ? 'SOCKET TESTS PASSED' : failures + ' FAILURES'));
}

run()
  .catch((e) => { failures++; console.log('  ERROR ' + e.message); })
  .then(() => {
    if (server) try { server.kill(); } catch (e) {}
    setTimeout(() => process.exit(failures === 0 ? 0 : 1), 300);
  });
