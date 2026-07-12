// HTTP API routes. Kept thin: they validate query input and delegate to the
// services. New endpoints (accounts, stats, history, ...) slot in here.
const express = require('express');
const leaderboard = require('../services/leaderboardService');

const router = express.Router();

// Health check for platform probes (Koyeb, load balancers, uptime monitors).
// Exposed at both /api/health and /api/healthz for convention compatibility.
function health(req, res) {
  res.json({ ok: true, uptime: Math.round(process.uptime()) });
}
router.get('/health', health);
router.get('/healthz', health);

// Public leaderboard. Optional ?limit= caps the number of rows.
router.get('/leaderboard', (req, res) => {
  const limit = Number(req.query.limit);
  res.json({ leaderboard: leaderboard.getTopScores(Number.isFinite(limit) ? limit : undefined) });
});

// Lightweight aggregate stats derived from the leaderboard.
router.get('/stats', (req, res) => {
  res.json(leaderboard.getStats());
});

module.exports = router;
