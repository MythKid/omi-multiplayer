// Socket integration tests: duplicate joins, invalid packets, reconnect
// (reclaiming a seat with a session token), and lobby cleanup. Spawns a real
// server on a test port and drives it with real socket.io clients.
const { spawn } = require('child_process');
const { io } = require('socket.io-client');

const PORT = 3991;
const URL = 'http://127.0.0.1:' + PORT;
let failures = 0;
const ok = (c, m) => { console.log((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) failures++; };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function connect(opts) {
  return io(URL, Object.assign({ transports: ['websocket'], reconnection: false }, opts || {}));
}
function waitEvent(sock, event, ms) {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), ms || 3000);
    sock.once(event, (d) => { clearTimeout(t); resolve(d === undefined ? {} : d); });
  });
}

let server;
function startServer() {
  return new Promise((resolve, reject) => {
    server = spawn(process.execPath, ['server.js'], {
      cwd: __dirname,
      env: Object.assign({}, process.env, { PORT: String(PORT), LOG_LEVEL: 'error' }),
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

  // --- duplicate join on one socket keeps a single seat ---
  const a = connect();
  await waitEvent(a, 'connect');
  a.emit('join', { name: 'Alice' });
  const firstLobby = await waitEvent(a, 'lobby-update');
  ok(firstLobby && firstLobby.players.length === 1, 'first join seats one player');
  let latest = firstLobby;
  a.on('lobby-update', (d) => { latest = d; });
  a.emit('join', { name: 'AliceAgain' }); // duplicate
  await wait(300);
  ok(latest.players.length === 1 && latest.players[0].name === 'Alice', 'duplicate join is ignored');

  // --- malformed packets do not crash the server ---
  a.emit('set-mode', { mode: 'banana' });
  a.emit('set-teams', { pairing: {} });
  a.emit('play-card', { cardIndex: 99999 });
  a.emit('shuffle-done', { entropy: 'nope', ops: 42 });
  a.emit('vote-end', { action: 12345 });
  a.emit('kapothi-call', {});
  a.emit('choose-trump', { suit: '<script>' });
  a.emit('cut-done', { segments: 'nope' });
  await wait(400);
  const probe = connect();
  ok(!!(await waitEvent(probe, 'connect')), 'server survives malformed packets and still accepts connections');
  probe.close();
  a.close();
  await wait(200);

  // --- reconnect: reclaim a seat with the session token ---
  const host = connect();
  await waitEvent(host, 'connect');
  const tokenP = waitEvent(host, 'session', 3000);
  host.emit('join', { name: 'Host' });
  const session = await tokenP;
  ok(session && typeof session.token === 'string', 'server issues a session token on join');
  await waitEvent(host, 'lobby-update');
  host.emit('set-mode', { mode: 4 });
  await wait(150);
  host.emit('host-start');
  const gs = await waitEvent(host, 'state-update', 4000);
  ok(gs && gs.phase, 'game starts (phase: ' + (gs && gs.phase) + ')');

  // A stranger without a token is refused during the active game.
  const stranger = connect();
  ok(!!(await waitEvent(stranger, 'server-error', 3000)), 'connection without a token is refused mid-game');
  stranger.close();

  // The host "refreshes": drop the socket, reconnect with the same token.
  host.disconnect();
  await wait(400); // well within the grace window
  const resumed = connect({ auth: { token: session.token } });
  const back = await waitEvent(resumed, 'state-update', 4000);
  ok(back && back.mySeat === 0, 'reconnect with the token restores the seat (mySeat ' + (back && back.mySeat) + ')');
  ok(back && back.phase, 'reconnected client receives the live game state');

  // End the match cleanly (single human vote) so the game tears down.
  resumed.emit('vote-end', { action: 'propose' });
  const over = await new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), 3000);
    resumed.on('state-update', (d) => { if (d.gameOver) { clearTimeout(t); resolve(d); } });
  });
  ok(over && over.gameOver, 'unanimous end-match vote finishes the game');
  resumed.close();
  await wait(400);

  // --- lobby cleanup: after everyone left, a fresh client is host/seat 0 ---
  const late = connect();
  await waitEvent(late, 'connect');
  const lateLobbyP = waitEvent(late, 'lobby-update', 3000);
  late.emit('join', { name: 'Newcomer' });
  const ll = await lateLobbyP;
  ok(ll && ll.players.length === 1 && ll.isHost && ll.yourSeat === 0,
    'lobby is clean after everyone left: newcomer becomes host at seat 0');
  late.close();

  console.log('\n' + (failures === 0 ? 'SOCKET TESTS PASSED' : failures + ' FAILURES'));
}

run()
  .catch((e) => { failures++; console.log('  ERROR ' + e.message); })
  .then(() => {
    if (server) try { server.kill(); } catch (e) {}
    setTimeout(() => process.exit(failures === 0 ? 0 : 1), 300);
  });
