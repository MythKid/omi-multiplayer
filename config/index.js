// Central configuration. Everything tunable comes from the environment so
// the same build runs on a laptop, a LAN host, or a public deployment
// (Koyeb, Cloudflare, etc.) without code changes. See .env.example.
const path = require('path');

// Load a local .env when present. In a real deployment the platform injects
// the variables directly, so a missing file is fine.
try { require('dotenv').config({ quiet: true }); } catch (e) { /* dotenv optional */ }

function toInt(value, fallback) {
  const n = Number(value);
  return Number.isInteger(n) ? n : fallback;
}

// Positive number (fractions allowed), used for the minute-based timeouts.
function toPositive(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const nodeEnv = process.env.NODE_ENV || 'development';
const isProduction = nodeEnv === 'production';

const port = (() => {
  const p = toInt(process.env.PORT, 3000);
  return p >= 1 && p <= 65535 ? p : 3000;
})();

// Comma-separated list of hostnames the server will answer to. Leave empty on
// a LAN (private addresses are allowed automatically). Set it in production to
// lock the server to your domain.
const allowedHosts = String(process.env.ALLOWED_HOSTS || '')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

// Number of tables (independent game slots). Each table seats up to four
// players, so the socket cap scales with it, plus headroom for people who are
// browsing the tables screen.
const maxSlots = Math.max(1, Math.min(16, toInt(process.env.MAX_SLOTS, 4)));
const maxSocketsExplicit = String(process.env.MAX_SOCKETS || '').trim() !== '';
const maxSockets = maxSocketsExplicit
  ? Math.max(1, toInt(process.env.MAX_SOCKETS, maxSlots * 4 + 16))
  : maxSlots * 4 + 16;

module.exports = {
  nodeEnv,
  isProduction,
  port,
  bindAddress: process.env.BIND_ADDRESS || '0.0.0.0',
  trustProxy: toInt(process.env.TRUST_PROXY, 1),
  allowedHosts,
  // Public base URL to advertise (QR code / join link) when deployed. On a
  // LAN this stays empty and the reachable LAN address is detected instead.
  publicUrl: String(process.env.PUBLIC_URL || '').trim().replace(/\/$/, ''),
  maxSlots,
  maxSockets,
  maxSocketsExplicit,
  // A game waiting this long on one human (turn, shuffle, cut, ready check)
  // is ended so an idle player cannot hold a table forever. Lobbies with no
  // activity close after their own timeout.
  gameIdleMs: Math.round(toPositive(process.env.GAME_IDLE_MIN, 5) * 60 * 1000),
  lobbyIdleMs: Math.round(toPositive(process.env.LOBBY_IDLE_MIN, 15) * 60 * 1000),
  // Where persistent data (the leaderboard) is written. Uses the working
  // directory, which stays writable both for `node` and the packaged exe.
  dataDir: process.env.DATA_DIR || path.join(process.cwd(), 'data'),
  dbDriver: String(process.env.DB_DRIVER || 'auto').toLowerCase(), // auto | sqlite | json
  leaderboardSize: toInt(process.env.LEADERBOARD_SIZE, 100),
  logLevel: String(process.env.LOG_LEVEL || (isProduction ? 'info' : 'debug')).toLowerCase(),
};
