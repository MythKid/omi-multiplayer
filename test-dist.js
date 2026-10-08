// Distribution-readiness checks: the things that decide whether someone can
// clone this repo, install, run, and play without hitting a single snag.
// Static preflight first, then a live server smoke test. Run: npm run test:dist
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawnSync, spawn } = require('child_process');

const ROOT = __dirname;
let failures = 0;
let checks = 0;
function ok(cond, msg) {
  checks++;
  if (cond) { console.log('  PASS  ' + msg); }
  else { failures++; console.log('  FAIL  ' + msg); }
}
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const exists = f => fs.existsSync(path.join(ROOT, f));

console.log('OMI distribution checks\n');

// ---------------------------------------------------------------------------
console.log('[1] Files a fresh clone must contain');
// ---------------------------------------------------------------------------
const REQUIRED = [
  'package.json', 'package-lock.json', 'server.js', 'game.js', 'test.js',
  'test-dist.js', 'test-leaderboard.js', 'test-rating.js', 'test-sockets.js',
  'README.md', 'CHANGELOG.md', 'LICENSE', '.gitignore', '.env.example',
  'config/index.js', 'utils/logger.js', 'utils/network.js', 'utils/sanitize.js',
  'database/index.js', 'database/sqliteStore.js', 'database/jsonStore.js',
  'services/gameManager.js', 'services/table.js', 'services/chat.js',
  'services/leaderboardService.js', 'services/rating.js', 'services/identity.js', 'routes/api.js',
  'public/index.html', 'public/js/chat.js', 'public/js/leaderboard.js', 'public/socket.io.min.js',
  'public/css/styles.css', 'public/js/app.js',
  'public/manifest.webmanifest', 'public/sw.js', 'public/favicon.ico',
  'public/icons/icon.svg', 'public/icons/icon-maskable.svg', 'public/icons/favicon.svg',
  'public/icons/favicon-16.png', 'public/icons/favicon-32.png',
  'public/icons/apple-touch-icon.png',
  'public/icons/icon-192.png', 'public/icons/icon-512.png',
  'public/icons/maskable-192.png', 'public/icons/maskable-512.png',
  'public/icons/og-image.png', 'public/icons/og-image.svg',
  'public/404.html', 'public/500.html',
];
REQUIRED.forEach(f => ok(exists(f), 'present: ' + f));

// None of the required files may be excluded by .gitignore, or the clone
// would be missing them.
const gitignore = read('.gitignore').split(/\r?\n/).map(s => s.trim())
  .filter(s => s && !s.startsWith('#'));
function ignored(file) {
  return gitignore.some(rule => {
    const r = rule.replace(/\/$/, '');
    return file === r || file.startsWith(r + '/') || path.basename(file) === r;
  });
}
REQUIRED.forEach(f => ok(!ignored(f), 'not gitignored: ' + f));
ok(ignored('node_modules'), '.gitignore excludes node_modules');
ok(ignored('omi.exe'), '.gitignore excludes omi.exe');

// ---------------------------------------------------------------------------
console.log('\n[2] package.json contract');
// ---------------------------------------------------------------------------
const pkg = JSON.parse(read('package.json'));
ok(pkg.name && pkg.version, 'has name and version');
ok(pkg.license, 'declares a license');
ok(pkg.author, 'declares an author');
ok(pkg.main === 'server.js', 'main points at server.js');
ok(pkg.scripts && pkg.scripts.start === 'node server.js', 'has a start script');
ok(pkg.scripts && pkg.scripts.test, 'has a test script');
ok(pkg.scripts && pkg.scripts.build, 'has a build script');
ok(pkg.engines && pkg.engines.node, 'declares a supported Node version (engines.node)');
ok(/^\d+\.\d+\.\d+$/.test(pkg.version), 'version is semver (' + pkg.version + ')');
const lock = JSON.parse(read('package-lock.json'));
ok(lock.version === pkg.version && lock.packages && lock.packages[''] && lock.packages[''].version === pkg.version,
  'package-lock.json carries the same version');
ok(read('CHANGELOG.md').includes('## ' + pkg.version + ' '), 'CHANGELOG.md has notes for ' + pkg.version);
ok(read('public/index.html').includes('v' + pkg.version + '<'), 'the in-game version label shows ' + pkg.version);
['express', 'socket.io', 'chalk', 'qrcode', 'qrcode-terminal'].forEach(d =>
  ok(pkg.dependencies && pkg.dependencies[d], 'runtime dependency declared: ' + d));

// The socket cap must always leave room for every table's seats, even when an
// older, smaller MAX_SOCKETS is still set on the hosting platform.
function socketCap(env) {
  const base = Object.assign({}, process.env);
  delete base.MAX_SOCKETS;
  delete base.MAX_SLOTS;
  const r = spawnSync(process.execPath, ['-e', "console.log(require('./config').maxSockets)"],
    { cwd: ROOT, encoding: 'utf8', env: Object.assign(base, env) });
  return Number(String(r.stdout).trim());
}
ok(socketCap({}) === 32, 'MAX_SOCKETS unset: 4 tables get 32 connections');
ok(socketCap({ MAX_SOCKETS: '16' }) === 20, 'a leftover MAX_SOCKETS=16 is raised to fit 4 tables (20)');
ok(socketCap({ MAX_SOCKETS: '100' }) === 100, 'a larger MAX_SOCKETS is kept');
ok(socketCap({ MAX_SLOTS: '2', MAX_SOCKETS: '16' }) === 16, 'MAX_SOCKETS=16 is enough for 2 tables');
ok(socketCap({ MAX_SOCKETS: 'lots' }) === 32, 'a non-numeric MAX_SOCKETS falls back to the default');

// The lobby's invite must be an address friends can reach: the public domain
// when deployed (even without PUBLIC_URL), the LAN address when hosting at home.
function inviteOf(env, headers) {
  const base = Object.assign({}, process.env);
  ['NODE_ENV', 'PUBLIC_URL', 'PORT'].forEach(k => { delete base[k]; });
  const code = "console.log(JSON.stringify(require('./utils/network').inviteBase(" + JSON.stringify(headers) + ')))';
  const r = spawnSync(process.execPath, ['-e', code],
    { cwd: ROOT, encoding: 'utf8', env: Object.assign(base, { LOG_LEVEL: 'error' }, env) });
  try { return JSON.parse(String(r.stdout).trim()); } catch (e) { return {}; }
}
let inv = inviteOf({ NODE_ENV: 'production' }, { host: 'omi.example.org', 'x-forwarded-proto': 'https' });
ok(inv.base === 'https://omi.example.org' && inv.lan === false,
  'deployed without PUBLIC_URL: the invite uses the public domain, not the container address');
inv = inviteOf({ NODE_ENV: 'production', PUBLIC_URL: 'https://play.example.org' }, { host: 'omi.example.org' });
ok(inv.base === 'https://play.example.org', 'PUBLIC_URL wins when it is set');
inv = inviteOf({}, { host: 'localhost:3000' });
ok(/^http:\/\/[\d.]+:3000$/.test(inv.base) && inv.lan === true, 'hosting at home: the invite uses the LAN address (' + inv.base + ')');
inv = inviteOf({ NODE_ENV: 'production' }, { host: '<bad host>' });
ok(inv.lan === true && !/bad/.test(inv.base), 'a malformed Host header never ends up in an invite');

// ---------------------------------------------------------------------------
console.log('\n[3] Client assets resolve');
// ---------------------------------------------------------------------------
const html = read('public/index.html');
// Every local (root-relative) asset the page references must exist on disk.
const localRefs = (html.match(/(?:src|href)="(\/[^"]*)"/g) || [])
  .map(m => m.match(/"(\/[^"]*)"/)[1]);
const uniqueLocal = Array.from(new Set(localRefs));
ok(uniqueLocal.length > 0, 'page references at least one local asset');
uniqueLocal.forEach(ref => {
  const onDisk = path.join(ROOT, 'public', ref.replace(/^\//, ''));
  ok(fs.existsSync(onDisk), 'local asset exists: ' + ref);
});
// External refs must be https (mixed content would be blocked on some setups).
const extRefs = (html.match(/(?:src|href)="(https?:\/\/[^"]*)"/g) || [])
  .map(m => m.match(/"(https?:\/\/[^"]*)"/)[1]);
ok(extRefs.every(u => u.startsWith('https://')), 'external references all use https');

// The committed socket.io client must match the installed server version,
// or a version bump silently breaks the handshake.
function sioVersion(text) { const m = text.match(/Socket\.IO v([0-9.]+)/); return m && m[1]; }
const clientVer = sioVersion(read('public/socket.io.min.js'));
let serverVer = null;
try { serverVer = require('./node_modules/socket.io/package.json').version; } catch (e) {}
ok(clientVer, 'socket.io.min.js has a version banner (' + clientVer + ')');
if (serverVer) ok(clientVer === serverVer, 'client socket.io ' + clientVer + ' matches server ' + serverVer);

// ---------------------------------------------------------------------------
console.log('\n[4] Source integrity');
// ---------------------------------------------------------------------------
[
  'server.js', 'game.js', 'test.js', 'test-dist.js', 'test-leaderboard.js', 'test-rating.js',
  'test-sockets.js', 'config/index.js', 'utils/logger.js', 'utils/network.js', 'utils/sanitize.js',
  'database/index.js', 'database/jsonStore.js', 'database/sqliteStore.js',
  'services/gameManager.js', 'services/table.js', 'services/chat.js',
  'services/leaderboardService.js', 'services/rating.js', 'services/identity.js', 'routes/api.js',
].forEach(f => {
  const r = spawnSync(process.execPath, ['--check', path.join(ROOT, f)], { encoding: 'utf8' });
  ok(r.status === 0, 'parses without syntax errors: ' + f);
});
// The client scripts live in their own files; they must parse too.
['public/js/app.js', 'public/js/chat.js', 'public/js/leaderboard.js'].forEach(f => {
  let parses = false;
  try { new Function(read(f)); parses = true; } catch (e) {}
  ok(parses, 'client script (' + f + ') parses');
});

// game.js must stay pure (no I/O), so it can be reused and unit-tested freely.
const gameSrc = read('game.js');
ok(!/require\(['"](fs|net|http|express|socket\.io|dgram)['"]\)/.test(gameSrc),
  'game.js pulls in no I/O modules (stays pure)');

// No stray em or en dashes, and no AI-tool signatures, in shipped text.
const SHIPPED = [
  'server.js', 'game.js', 'test.js', 'public/index.html', 'public/js/app.js',
  'public/css/styles.css', 'README.md', 'CHANGELOG.md', 'package.json',
  'services/gameManager.js', 'services/table.js', 'services/chat.js', 'services/leaderboardService.js',
  'services/rating.js', 'services/identity.js', 'database/sqliteStore.js', 'database/jsonStore.js',
  'public/sw.js', 'public/js/chat.js', 'public/js/leaderboard.js', 'routes/api.js', 'config/index.js',
];
SHIPPED.forEach(f => ok(!/[—–]/.test(read(f)), 'no em/en dashes in ' + f));
SHIPPED.forEach(f => ok(!/\b(anthropic|claude)\b/i.test(read(f)), 'no AI-tool signatures in ' + f));

// ---------------------------------------------------------------------------
console.log('\n[5] Live server smoke test');
// ---------------------------------------------------------------------------
function request(pathname, headers) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port: TEST_PORT, path: pathname, headers },
      (res) => {
        let body = '';
        res.on('data', c => { body += c; });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
      });
    req.on('error', () => resolve({ status: 0, headers: {}, body: '' }));
    req.end();
  });
}
function waitFor(regex, stream, timeoutMs) {
  return new Promise((resolve) => {
    let buf = '';
    const t = setTimeout(() => resolve(false), timeoutMs);
    stream.on('data', (d) => {
      buf += d.toString();
      if (regex.test(buf)) { clearTimeout(t); resolve(true); }
    });
  });
}

const TEST_PORT = 3999;
const SMOKE_DATA = fs.mkdtempSync(path.join(require('os').tmpdir(), 'omi-dist-test-'));
let server;

async function runSmoke() {
  server = spawn(process.execPath, ['server.js'], {
    // A throwaway data directory, so the smoke test never touches ./data.
    cwd: ROOT, env: Object.assign({}, process.env, { PORT: String(TEST_PORT), DATA_DIR: SMOKE_DATA }),
  });
  const ready = await waitFor(/running|listening/i, server.stdout, 8000);
  ok(ready, 'server starts and reports it is running');
  if (!ready) return;

  // Honours the PORT env var so it can run without clobbering port 3000.
  const root = await request('/');
  ok(root.status === 200, 'GET / returns 200');
  ok(/screen-join|OMI/.test(root.body), 'GET / serves the game page');

  // Security headers.
  ok(/default-src/.test(root.headers['content-security-policy'] || ''), 'sends a Content-Security-Policy');
  ok((root.headers['x-content-type-options'] || '') === 'nosniff', 'sends X-Content-Type-Options: nosniff');
  ok((root.headers['x-frame-options'] || '') === 'DENY', 'sends X-Frame-Options: DENY');

  // The socket.io client must be served as real JavaScript, not the HTML
  // fallback. This is the check that catches a missing/mis-served client.
  const sock = await request('/socket.io.min.js');
  ok(sock.status === 200, 'GET /socket.io.min.js returns 200');
  ok(/socket\.io|Socket\.IO/i.test(sock.body) && !/<!DOCTYPE html>/i.test(sock.body),
    'GET /socket.io.min.js serves the real client, not the HTML page');
  ok((sock.headers['content-type'] || '').includes('javascript'),
    'socket.io.min.js is served with a JavaScript content type');

  // A missing asset must NOT masquerade as the HTML page (that would make a
  // missing script fail silently instead of erroring honestly).
  const missing = await request('/definitely-not-here.js');
  ok(!(missing.status === 200 && /<!DOCTYPE html>/i.test(missing.body)),
    'a missing .js asset does not return the HTML page with 200');

  // DNS-rebinding guard: a foreign Host header is refused.
  const spoof = await request('/', { Host: 'evil.example.com' });
  ok(spoof.status === 403, 'spoofed Host header is rejected (403)');

  // API endpoints respond with valid JSON.
  for (const p of ['/api/health', '/api/healthz']) {
    const health = await request(p);
    let healthOk = false;
    try {
      const h = JSON.parse(health.body);
      healthOk = health.status === 200 && h.ok === true && h.version === pkg.version;
    } catch (e) {}
    ok(healthOk, 'GET ' + p + ' returns ok with version ' + pkg.version);
  }

  const board = await request('/api/leaderboard');
  let boardOk = false;
  try { boardOk = board.status === 200 && Array.isArray(JSON.parse(board.body).leaderboard); } catch (e) {}
  ok(boardOk, 'GET /api/leaderboard returns a leaderboard array');

  const stats = await request('/api/stats');
  let statsOk = false;
  try {
    const st = JSON.parse(stats.body);
    statsOk = stats.status === 200 && typeof st.players === 'number' && typeof st.matches === 'number' &&
      typeof st.tables === 'number';
  } catch (e) {}
  ok(statsOk, 'GET /api/stats returns aggregate stats');

  const recent = await request('/api/matches?limit=5');
  let recentOk = false;
  try { recentOk = recent.status === 200 && Array.isArray(JSON.parse(recent.body).matches); } catch (e) {}
  ok(recentOk, 'GET /api/matches returns a matches array');

  const history = await request('/api/players/' + encodeURIComponent('Some One') + '/matches');
  let historyOk = false;
  try { historyOk = history.status === 200 && Array.isArray(JSON.parse(history.body).matches); } catch (e) {}
  ok(historyOk, 'GET /api/players/:name/matches returns a history');

  const badId = await request('/api/matches/not-a-number');
  ok(badId.status === 400, 'GET /api/matches/:id rejects a malformed id (400)');
  const noMatch = await request('/api/matches/987654321');
  ok(noMatch.status === 404, 'GET /api/matches/:id returns 404 for an unknown match');

  // PWA assets are served.
  const manifest = await request('/manifest.webmanifest');
  ok(manifest.status === 200 && /manifest/i.test(manifest.headers['content-type'] || ''),
    'GET /manifest.webmanifest served with the manifest type');
  const sw = await request('/sw.js');
  ok(sw.status === 200 && /serviceWorker|caches/i.test(sw.body), 'GET /sw.js serves the service worker');

  // A genuinely missing asset returns the themed 404 page.
  const notFound = await request('/nope.png');
  ok(notFound.status === 404 && /404/.test(notFound.body), 'missing asset returns the themed 404 page');

  const tablesRes = await request('/api/tables');
  let tablesOk = false;
  try {
    const t = JSON.parse(tablesRes.body).tables;
    tablesOk = tablesRes.status === 200 && Array.isArray(t) && t.length > 0 && t[0].status === 'empty';
  } catch (e) {}
  ok(tablesOk, 'GET /api/tables lists the tables');

  // Real client can connect, sit at a table, and reach its lobby.
  const { io } = require('socket.io-client');
  const client = io('http://127.0.0.1:' + TEST_PORT,
    { transports: ['websocket'], reconnection: false, auth: { v: 2 } });
  const joined = await new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), 5000);
    client.on('lobby-update', (d) => { clearTimeout(t); resolve(!!d && d.tableId === 1); });
    client.on('connect', () => client.emit('join-table', { tableId: 1, name: 'Tester' }));
    client.on('connect_error', () => { clearTimeout(t); resolve(false); });
  });
  ok(joined, 'a socket.io client connects and sits at a table');

  // Malformed input must not crash the server.
  client.emit('set-mode', { mode: 'not-a-number' });
  client.emit('play-card', { cardIndex: 99999 });
  client.emit('set-teams', { pairing: 'x' });
  client.emit('host-start');
  await new Promise(r => setTimeout(r, 600));
  const stillUp = await request('/');
  ok(stillUp.status === 200, 'server survives malformed input and keeps serving');

  client.close();
}

runSmoke()
  .catch((e) => { failures++; console.log('  ERROR ' + e.message); })
  .then(() => {
    if (server) try { server.kill(); } catch (e) {}
    setTimeout(() => {
      try { fs.rmSync(SMOKE_DATA, { recursive: true, force: true }); } catch (e) {}
      console.log('\n' + (failures === 0
        ? 'ALL ' + checks + ' DISTRIBUTION CHECKS PASSED'
        : failures + ' of ' + checks + ' CHECKS FAILED'));
      process.exit(failures === 0 ? 0 : 1);
    }, 200);
  });
