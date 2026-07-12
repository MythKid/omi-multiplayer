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
  'test-dist.js', 'test-leaderboard.js', 'test-sockets.js',
  'README.md', 'LICENSE', '.gitignore', '.env.example',
  'config/index.js', 'utils/logger.js', 'utils/network.js', 'utils/sanitize.js',
  'database/index.js', 'database/sqliteStore.js', 'database/jsonStore.js',
  'services/gameManager.js', 'services/leaderboardService.js', 'routes/api.js',
  'public/index.html', 'public/socket.io.min.js',
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
['express', 'socket.io', 'chalk', 'qrcode', 'qrcode-terminal'].forEach(d =>
  ok(pkg.dependencies && pkg.dependencies[d], 'runtime dependency declared: ' + d));

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
  'server.js', 'game.js', 'test.js', 'test-dist.js', 'test-leaderboard.js', 'test-sockets.js',
  'config/index.js', 'utils/logger.js', 'utils/network.js', 'utils/sanitize.js',
  'database/index.js', 'database/jsonStore.js', 'database/sqliteStore.js',
  'services/gameManager.js', 'services/leaderboardService.js', 'routes/api.js',
].forEach(f => {
  const r = spawnSync(process.execPath, ['--check', path.join(ROOT, f)], { encoding: 'utf8' });
  ok(r.status === 0, 'parses without syntax errors: ' + f);
});
// The client script lives in its own file now; it must parse too.
let clientParses = false;
try { new Function(read('public/js/app.js')); clientParses = true; } catch (e) {}
ok(clientParses, 'client script (public/js/app.js) parses');

// game.js must stay pure (no I/O), so it can be reused and unit-tested freely.
const gameSrc = read('game.js');
ok(!/require\(['"](fs|net|http|express|socket\.io|dgram)['"]\)/.test(gameSrc),
  'game.js pulls in no I/O modules (stays pure)');

// No stray em or en dashes, and no AI-tool signatures, in shipped text.
const SHIPPED = [
  'server.js', 'game.js', 'test.js', 'public/index.html', 'public/js/app.js',
  'public/css/styles.css', 'README.md', 'package.json',
  'services/gameManager.js', 'services/leaderboardService.js',
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
let server;

async function runSmoke() {
  server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT, env: Object.assign({}, process.env, { PORT: String(TEST_PORT) }),
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
    try { healthOk = health.status === 200 && JSON.parse(health.body).ok === true; } catch (e) {}
    ok(healthOk, 'GET ' + p + ' returns ok');
  }

  const board = await request('/api/leaderboard');
  let boardOk = false;
  try { boardOk = board.status === 200 && Array.isArray(JSON.parse(board.body).leaderboard); } catch (e) {}
  ok(boardOk, 'GET /api/leaderboard returns a leaderboard array');

  const stats = await request('/api/stats');
  let statsOk = false;
  try { statsOk = stats.status === 200 && typeof JSON.parse(stats.body).teams === 'number'; } catch (e) {}
  ok(statsOk, 'GET /api/stats returns aggregate stats');

  // PWA assets are served.
  const manifest = await request('/manifest.webmanifest');
  ok(manifest.status === 200 && /manifest/i.test(manifest.headers['content-type'] || ''),
    'GET /manifest.webmanifest served with the manifest type');
  const sw = await request('/sw.js');
  ok(sw.status === 200 && /serviceWorker|caches/i.test(sw.body), 'GET /sw.js serves the service worker');

  // A genuinely missing asset returns the themed 404 page.
  const notFound = await request('/nope.png');
  ok(notFound.status === 404 && /404/.test(notFound.body), 'missing asset returns the themed 404 page');

  // Real client can connect, join, and reach the lobby.
  const { io } = require('socket.io-client');
  const client = io('http://127.0.0.1:' + TEST_PORT, { transports: ['websocket'], reconnection: false });
  const joined = await new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), 5000);
    client.on('lobby-update', (d) => { clearTimeout(t); resolve(!!d); });
    client.on('connect', () => client.emit('join', { name: 'Tester' }));
    client.on('connect_error', () => { clearTimeout(t); resolve(false); });
  });
  ok(joined, 'a socket.io client connects and joins the lobby');

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
      console.log('\n' + (failures === 0
        ? 'ALL ' + checks + ' DISTRIBUTION CHECKS PASSED'
        : failures + ' of ' + checks + ' CHECKS FAILED'));
      process.exit(failures === 0 ? 0 : 1);
    }, 200);
  });
