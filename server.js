// OMI server entry point. Sets up Express (security, compression, static
// assets, API routes), attaches Socket.IO, and starts the game manager.
// Configuration lives in config/, network helpers in utils/, persistence in
// database/, and the game orchestration in services/gameManager.js.
const path = require('path');
const http = require('http');
const express = require('express');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const { Server } = require('socket.io');
const qrterminal = require('qrcode-terminal');
const QRCode = require('qrcode');

const config = require('./config');
const logger = require('./utils/logger');
const network = require('./utils/network');
const apiRoutes = require('./routes/api');
const gameManager = require('./services/gameManager');
const db = require('./database');
const { version } = require('./package.json');

// A stray exception in one request or timer must never take the whole server
// down and disconnect everyone mid-game.
process.on('uncaughtException', (err) => logger.error('Uncaught exception:', err));
process.on('unhandledRejection', (err) => logger.error('Unhandled rejection:', err));

const app = express();
app.disable('x-powered-by');          // do not advertise the framework
app.set('trust proxy', config.trustProxy); // correct client IP / protocol behind a proxy

const server = http.createServer(app);
server.headersTimeout = 10000;        // trim slow-header (Slowloris) windows
server.requestTimeout = 30000;

const io = new Server(server, {
  serveClient: false,        // we ship our own client bundle
  maxHttpBufferSize: 1e5,    // 100 KB, well above the biggest legit payload
  allowRequest: (req, done) => {
    const ok = network.hostAllowed(req.headers.host)
      && network.originAllowed(req.headers.origin, req.headers.host);
    done(ok ? null : 'blocked origin', ok);
  },
});

// ---------- Middleware ----------

// Refuse requests addressed to a hostname we do not trust (DNS-rebinding
// protection on a LAN; an allowlist in production).
app.use((req, res, next) => {
  if (!network.hostAllowed(req.headers.host)) { res.status(403).send('Forbidden'); return; }
  next();
});

app.use(compression());

// Cap request bodies. The game has no large uploads, so a small limit is
// plenty and stops oversized-payload abuse of any future POST route.
app.use(express.json({ limit: '16kb' }));

// Rate limiting per client IP (trust-proxy aware). A generous overall cap
// covers the handful of asset requests a first load makes, with a tighter cap
// on the API. The Socket.IO path is excluded (it has its own per-socket limiter).
const skipSocketIO = (req) => req.path.startsWith('/socket.io');
app.use(rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skip: skipSocketIO,
}));
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
});

// Security headers. The client scripts and styles are served as files, so the
// script policy needs no 'unsafe-inline'. Fonts, data-URI images (the QR code)
// and WebSocket connections are allowed explicitly.
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'", 'ws:', 'wss:'],
      objectSrc: ["'none'"],
      baseUri: ["'none'"],
      frameAncestors: ["'none'"],
    },
  },
  frameguard: { action: 'deny' }, // no framing at all, matching frame-ancestors 'none'
  crossOriginEmbedderPolicy: false, // not needed, and it would block the QR data image on some setups
  // HSTS only meaningfully applies over HTTPS; harmless on a LAN.
}));

app.use('/api', apiLimiter, apiRoutes);

// Static assets. path.join(__dirname, 'public') resolves inside the packaged
// snapshot too. The web manifest gets its correct type explicitly.
const publicDir = path.join(__dirname, 'public');
app.use(express.static(publicDir, {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.webmanifest')) res.type('application/manifest+json');
  },
}));

// Unknown routes: the app page for plain routes; an honest, themed 404 for
// asset-looking paths (so a missing script errors loudly instead of receiving
// the app HTML), and JSON for the API.
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) { res.status(404).json({ error: 'Not found' }); return; }
  if (path.extname(req.path)) {
    res.status(404).sendFile(path.join(publicDir, '404.html'));
    return;
  }
  res.sendFile(path.join(publicDir, 'index.html'));
});

// Express error handler: log the detail, return a themed page with no stack.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  logger.error('Request error:', err && err.message ? err.message : err);
  if (res.headersSent) return;
  if (req.path.startsWith('/api/')) { res.status(500).json({ error: 'Server error' }); return; }
  res.status(500).sendFile(path.join(publicDir, '500.html'));
});

// ---------- Wire the game ----------

gameManager.init(io);
io.on('connection', (socket) => gameManager.handleConnection(socket));

// ---------- Startup ----------

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    logger.error(`Port ${config.port} is already in use. Another server may be running; ` +
      'stop it or set PORT to a free port, then start again.');
  } else {
    logger.error('Server error:', err.message);
  }
  process.exitCode = 1;
});

function printStartupBanner() {
  if (config.isProduction) {
    logger.info(`OMI v${version} listening on port ${config.port} (${config.nodeEnv}, ${config.maxSlots} tables)`);
    return;
  }
  // Development / LAN: friendly banner with a scannable QR code.
  const chalk = require('chalk');
  const url = network.getJoinURL();
  logger.print(chalk.green.bold('\n  OMI v' + version + ' is running with ' + config.maxSlots + ' tables.\n'));
  logger.print(chalk.white('  On this computer:  ') + chalk.cyan(`http://localhost:${config.port}`));
  logger.print(chalk.white('  On the network:    ') + chalk.cyan.bold(url));
  const host = network.getJoinHost();
  if (host) logger.print(chalk.white('  Or try:            ') + chalk.cyan(`http://${host}:${config.port}`));
  logger.print(chalk.yellow('\n  Others on the same Wi-Fi can scan this code or open the network link:\n'));
  qrterminal.generate(url, { small: true });
  logger.print(chalk.gray('\n  Leave this window open while you play. Close it to stop hosting.\n'));
}

async function start() {
  // Open the leaderboard store up front so any storage problem surfaces now.
  db.getStore();

  // Work out the reachable LAN address before advertising it (skipped when a
  // public URL is configured), then build the join QR, then listen.
  if (!config.publicUrl) await network.resolveLocalIP();
  // One join QR per table, so scanning a lobby's code lands at that table.
  for (const id of gameManager.tableIds()) {
    try {
      const qr = await QRCode.toDataURL(`${network.getJoinURL()}/?table=${id}`, {
        margin: 1, width: 320, errorCorrectionLevel: 'M',
        color: { dark: '#0d2b18ff', light: '#f4ecd0ff' },
      });
      gameManager.setTableQR(id, qr);
    } catch (e) {
      logger.warn(`Could not build the join QR code for table ${id}:`, e.message);
    }
  }
  if (config.maxSocketsExplicit && config.maxSockets < config.maxSlots * 4 + 4) {
    logger.warn(`MAX_SOCKETS=${config.maxSockets} is too low for ${config.maxSlots} tables; ` +
      `use at least ${config.maxSlots * 4 + 4} (or leave it unset).`);
  }

  server.listen(config.port, config.bindAddress, printStartupBanner);
}

// Close listeners and the database cleanly on shutdown so nothing is left
// half-written and the port is released promptly.
let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`Received ${signal}, shutting down.`);
  // io.close() also closes the underlying HTTP server and fires the callback
  // once everything is closed.
  io.close(() => {
    try { db.closeStore(); } catch (e) { /* ignore */ }
    process.exit(0);
  });
  // Force-exit if connections do not drain in time.
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

start();
