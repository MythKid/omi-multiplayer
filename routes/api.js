// HTTP API routes. Kept thin: they validate input and delegate to the
// services. New endpoints (accounts, stats, history, ...) slot in here.
const express = require('express');
const leaderboard = require('../services/leaderboardService');
const gameManager = require('../services/gameManager');

const router = express.Router();

const limitOf = (req) => {
  const n = Number(req.query.limit);
  return Number.isFinite(n) ? n : undefined;
};

// Health check for platform probes (Koyeb, load balancers, uptime monitors).
// Exposed at both /api/health and /api/healthz for convention compatibility.
function health(req, res) {
  res.json({ ok: true, uptime: Math.round(process.uptime()) });
}
router.get('/health', health);
router.get('/healthz', health);

// Rated players, best first. Optional ?limit= caps the number of rows.
router.get('/leaderboard', (req, res) => {
  res.json({ leaderboard: leaderboard.getLeaderboard(limitOf(req)) });
});

// One player's profile and recent matches, by display name.
router.get('/players/:name/matches', (req, res) => {
  const name = String(req.params.name || '');
  if (!name || name.length > 64) { res.status(400).json({ error: 'Bad player name' }); return; }
  res.json(leaderboard.getPlayerMatches(name, limitOf(req)));
});

// Most recent recorded matches.
router.get('/matches', (req, res) => {
  res.json({ matches: leaderboard.getRecentMatches(limitOf(req)) });
});

// One match with its round-by-round timeline.
router.get('/matches/:id', (req, res) => {
  if (!/^\d{1,10}$/.test(req.params.id)) { res.status(400).json({ error: 'Bad match id' }); return; }
  const match = leaderboard.getMatch(Number(req.params.id));
  if (!match) { res.status(404).json({ error: 'Not found' }); return; }
  res.json({ match });
});

// Lightweight aggregate stats.
router.get('/stats', (req, res) => {
  const tables = gameManager.tableSummaries();
  res.json(Object.assign(leaderboard.getStats(), {
    tables: tables.length,
    activeTables: tables.filter(t => t.status === 'playing').length,
  }));
});

// Live table summaries (the same data the tables screen shows).
router.get('/tables', (req, res) => {
  res.json({ tables: gameManager.tableSummaries() });
});

module.exports = router;
