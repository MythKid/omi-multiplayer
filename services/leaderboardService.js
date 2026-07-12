// Leaderboard business logic. Kept separate from both the game engine and
// the storage backend: the game reports a result, this service validates it,
// builds the team name, and records the team's best score.
const config = require('../config');
const logger = require('../utils/logger');
const { sanitizeName } = require('../utils/sanitize');
const db = require('../database');

// A team is simply "Player One + Player Two", generated automatically.
function makeTeamName(a, b) {
  return `${sanitizeName(a, 18) || 'Player'} + ${sanitizeName(b, 18) || 'Player'}`;
}

// Record a finished team's score. Only the higher score is kept per team
// (handled by the store's upsert). Returns the stored record, or null if the
// input was rejected.
function submitTeamResult(playerA, playerB, score) {
  const value = Math.round(Number(score));
  if (!Number.isInteger(value) || value <= 0 || value > 100000) return null;

  const team = makeTeamName(playerA, playerB);
  const date = new Date().toISOString();
  try {
    db.getStore().submit(team, value, date);
    logger.info(`Leaderboard: recorded ${team} = ${value}`);
    return { team, score: value, date };
  } catch (e) {
    logger.error('Leaderboard submit failed:', e.message);
    return null;
  }
}

// Top scores, highest first, each with a rank.
function getTopScores(limit) {
  const requested = Number(limit);
  const n = Math.max(1, Math.min(config.leaderboardSize,
    Number.isFinite(requested) ? requested : config.leaderboardSize));
  try {
    return db.getStore().top(n).map((r, i) => ({
      rank: i + 1,
      team: r.team,
      score: r.score,
      date: r.date,
    }));
  } catch (e) {
    logger.error('Leaderboard read failed:', e.message);
    return [];
  }
}

// Aggregate stats for the /api/stats endpoint and the leaderboard header.
function getStats() {
  const rows = getTopScores(config.leaderboardSize);
  return {
    teams: rows.length,
    topTeam: rows.length ? rows[0].team : null,
    topScore: rows.length ? rows[0].score : 0,
  };
}

module.exports = { makeTeamName, submitTeamResult, getTopScores, getStats };
