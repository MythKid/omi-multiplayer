// Leaderboard business logic. Kept separate from both the game engine and the
// storage backend: a table reports a finished (or abandoned) 4-player match,
// this service decides whether it counts, grades every player, moves the
// ratings, and hands one complete record to the store. It also shapes what
// the public API returns (never a claim hash).
const config = require('../config');
const logger = require('../utils/logger');
const db = require('../database');
const rating = require('./rating');
const identity = require('./identity');

const PROVISIONAL_SHOWN = 5; // games before a rating loses its "new" tag
const TIMELINE_MAX = 100;

const round1 = n => Math.round(n * 10) / 10;

// How a player who sits down under `name` (presenting `claim`, the secret
// their browser holds for that name, if any) will be treated.
//   rankable: their 4-player games can move a rating
//   secret:   kept in memory to register or re-verify the name at record time
//   issued:   a brand-new secret the client must store
function resolveIdentity(name, claim) {
  const key = rating.playerKey(name);
  const base = { key, rankable: false, reason: '', secret: null, issued: false };
  if (!rating.isRankableName(name)) return Object.assign(base, { reason: 'generic' });
  let row = null;
  try {
    row = db.getStore().getPlayer(key);
  } catch (e) {
    logger.error('Leaderboard read failed:', e.message);
    return Object.assign(base, { reason: 'unavailable' });
  }
  if (row) {
    return identity.verify(claim, row.claim_hash)
      ? Object.assign(base, { rankable: true, secret: claim })
      : Object.assign(base, { reason: 'claimed' });
  }
  if (identity.isWellFormed(claim)) return Object.assign(base, { rankable: true, secret: claim });
  return Object.assign(base, { rankable: true, secret: identity.newSecret(), issued: true });
}

// The round log, compacted for storage and the match timeline.
function timelineOf(history, teams) {
  return (history || []).slice(-TIMELINE_MAX).map(h => {
    if (h.type === 'redeal') {
      return { type: 'redeal', round: h.round, dealer: h.dealer, caller: h.callerSeat,
        trump: h.trump, counts: h.counts, shortTeam: h.shortTeam };
    }
    const tricks = [0, 1].map(t =>
      (h.tricksBySeat || []).reduce((sum, n, seat) => sum + (teams[seat] === t ? n : 0), 0));
    return { type: 'round', round: h.round, dealer: h.dealer, caller: h.callerSeat, trump: h.trump,
      tricks, tricksBySeat: h.tricksBySeat, outcome: h.outcome, scoringTeam: h.scoringTeam,
      points: h.points, kapothiTeam: h.kapothiTeam, bonusPaid: h.bonusPaid, scoreAfter: h.scoreAfter };
  });
}

// Record a 4-player match.
//   snap: { tableId, endReason: 'completed'|'vote'|'forfeit', leaverSeat,
//           history, players: [{ seat, name, team, isBot, score, identity }] }
// Returns { id, rated, note, seats: [...] } or null when nothing is stored.
function recordMatch(snap) {
  try {
    return recordMatchUnsafe(snap);
  } catch (e) {
    logger.error('Leaderboard record failed:', e.message);
    return null;
  }
}

function recordMatchUnsafe(snap) {
  const store = db.getStore();
  const seats = (snap.players || []).slice().sort((a, b) => a.seat - b.seat);
  if (seats.length !== 4) return null;
  const teams = seats.map(s => s.team);
  const score = [0, 1].map(t => seats.find(s => s.team === t).score);
  const stats = rating.deriveMatchStats(snap.history, teams);
  const roundsScored = stats.seats[0].rounds;
  const leaverSeat = Number.isInteger(snap.leaverSeat) ? snap.leaverSeat : -1;
  const forfeit = snap.endReason === 'forfeit';
  const cls = rating.classifyEnd({
    endReason: snap.endReason,
    scores: score,
    roundsScored,
    leaverTeam: leaverSeat >= 0 ? teams[leaverSeat] : null,
  });
  if (!cls.store) return null;

  // Re-check every claim now: another table may have registered one of
  // these names since this player sat down.
  const info = seats.map(s => {
    const id = s.identity;
    const out = { key: !s.isBot && id ? id.key : null, ranked: false, row: null, isNew: false, reason: '' };
    if (s.isBot) return out;
    if (!id || !id.rankable || !id.secret) {
      out.reason = (id && id.reason) || 'generic';
      return out;
    }
    out.row = store.getPlayer(id.key);
    if (out.row) {
      out.ranked = identity.verify(id.secret, out.row.claim_hash);
      if (!out.ranked) out.reason = 'claimed';
    } else {
      out.ranked = true;
      out.isNew = true;
    }
    return out;
  });
  if (!info.some(x => x.ranked)) return null; // no ranked player to record for

  const playedAt = new Date().toISOString();
  const lineup = rating.lineupKey(seats.map((s, i) => ({
    team: s.team, key: info[i].key, ranked: info[i].ranked, isBot: s.isBot,
  })));
  const since = new Date(Date.now() - rating.LINEUP_WINDOW_MS).toISOString();
  const factor = cls.rated ? rating.lineupFactor(store.countLineupSince(lineup, since)) : 0;
  const before = info.map(x => (x.row ? x.row : null));
  const deltas = cls.rated
    ? rating.ratingDeltas({
      seats: seats.map((s, i) => ({
        team: s.team,
        ranked: info[i].ranked,
        rating: before[i] ? before[i].rating : rating.START_RATING,
        games: before[i] ? before[i].games : 0,
      })),
      result: cls.result,
      margin: score[0] - score[1],
      factor,
      forfeit,
    })
    : seats.map(() => 0);

  const outSeats = seats.map((s, i) => {
    const team = s.team;
    const grade = s.isBot ? null : rating.gradeFor({
      result: cls.result[team],
      tokens: score[team],
      oppTokens: score[1 - team],
      stat: stats.seats[i],
      totalTricks: stats.totalTricks,
      forfeited: forfeit && i === leaverSeat,
    });
    const rated = cls.rated && info[i].ranked;
    const ratingBefore = info[i].ranked ? (before[i] ? before[i].rating : rating.START_RATING) : null;
    return {
      seat: s.seat,
      team,
      key: info[i].key,
      name: s.name,
      isBot: !!s.isBot,
      rated,
      ratingBefore: ratingBefore != null ? round1(ratingBefore) : null,
      ratingAfter: rated ? round1(ratingBefore + deltas[i]) : (ratingBefore != null ? round1(ratingBefore) : null),
      delta: rated ? deltas[i] : 0,
      grade: grade ? grade.letter : null,
      gradeScore: grade ? grade.score : null,
      tricks: stats.seats[i].tricks,
      calls: stats.seats[i].calls,
      callsMade: stats.seats[i].callsMade,
      reason: info[i].reason || (!cls.rated && info[i].ranked ? 'unrated-match' : ''),
    };
  });

  const players = [];
  if (cls.rated) {
    outSeats.forEach((s, i) => {
      if (!s.rated) return;
      const prev = before[i] || {
        rating: rating.START_RATING, games: 0, wins: 0, losses: 0, draws: 0, grade_sum: 0,
        best_rating: rating.START_RATING,
      };
      const res = cls.result[s.team];
      const row = {
        key: s.key,
        name: s.name,
        rating: s.ratingAfter,
        games: prev.games + 1,
        wins: prev.wins + (res === 1 ? 1 : 0),
        losses: prev.losses + (res === 0 ? 1 : 0),
        draws: prev.draws + (res === 0.5 ? 1 : 0),
        grade_sum: prev.grade_sum + (s.gradeScore || 0),
        best_rating: Math.max(prev.best_rating, s.ratingAfter),
        last_delta: s.delta,
        last_played: playedAt,
      };
      if (info[i].isNew) {
        row.claim_hash = identity.hashSecret(seats[i].identity.secret);
        row.created_at = playedAt;
      }
      players.push({ isNew: info[i].isNew, row });
    });
  }

  const winnerTeam = cls.result[0] === 1 ? 0 : cls.result[1] === 1 ? 1 : null;
  const id = store.recordMatch({
    playedAt,
    tableId: snap.tableId || null,
    endReason: snap.endReason,
    rated: cls.rated,
    winnerTeam,
    score,
    rounds: roundsScored,
    redeals: stats.redeals,
    lineupKey: lineup,
    note: cls.note,
    summary: { timeline: timelineOf(snap.history, teams), leaverSeat },
    seats: outSeats,
    players,
  });
  logger.info(`Leaderboard: match ${id} recorded (${snap.endReason}, ${cls.rated ? 'rated' : 'unrated'}, ` +
    `${score[0]}-${score[1]})`);
  return { id, rated: cls.rated, note: cls.note, seats: outSeats };
}

// ---------- Public views ----------

function publicPlayer(row, rank) {
  const games = row.games || 0;
  const avg = games ? Math.round(row.grade_sum / games) : null;
  return {
    rank,
    name: row.name,
    key: row.key,
    rating: Math.round(row.rating),
    delta: round1(row.last_delta || 0),
    games,
    wins: row.wins,
    losses: row.losses,
    draws: row.draws,
    winRate: games ? Math.round((100 * row.wins) / games) : 0,
    avgGradeScore: avg,
    avgGrade: avg == null ? null : rating.gradeLetter(avg),
    bestRating: Math.round(row.best_rating),
    lastPlayed: row.last_played,
    provisional: games < PROVISIONAL_SHOWN,
  };
}

function publicMatch(m, withTimeline) {
  const out = {
    id: m.id,
    playedAt: m.played_at,
    tableId: m.table_id,
    endReason: m.end_reason,
    rated: !!m.rated,
    winnerTeam: m.winner_team,
    score: [m.score_a, m.score_b],
    rounds: m.rounds,
    redeals: m.redeals,
    note: m.note || '',
    seats: (m.seats || []).map(s => ({
      seat: s.seat,
      team: s.team,
      name: s.name,
      key: s.player_key,
      isBot: !!s.is_bot,
      rated: !!s.rated,
      ratingAfter: s.rating_after != null ? Math.round(s.rating_after) : null,
      delta: s.delta,
      grade: s.grade,
      gradeScore: s.grade_score,
      tricks: s.tricks,
      calls: s.calls,
      callsMade: s.calls_made,
    })),
  };
  if (withTimeline) {
    let summary = {};
    try { summary = JSON.parse(m.summary_json || '{}'); } catch (e) { summary = {}; }
    out.timeline = Array.isArray(summary.timeline) ? summary.timeline : [];
    out.leaverSeat = Number.isInteger(summary.leaverSeat) ? summary.leaverSeat : -1;
  }
  return out;
}

function clampLimit(limit, max) {
  const n = Number(limit);
  return Math.max(1, Math.min(max, Number.isFinite(n) ? Math.floor(n) : max));
}

// Rated players, best first.
function getLeaderboard(limit) {
  try {
    return db.getStore().topPlayers(clampLimit(limit, config.leaderboardSize))
      .map((row, i) => publicPlayer(row, i + 1));
  } catch (e) {
    logger.error('Leaderboard read failed:', e.message);
    return [];
  }
}

// One player's profile and recent matches (looked up by display name).
function getPlayerMatches(name, limit) {
  const key = rating.playerKey(name);
  if (!key) return { player: null, matches: [] };
  try {
    const store = db.getStore();
    const row = store.getPlayer(key);
    return {
      player: row && row.games > 0 ? publicPlayer(row, null) : null,
      matches: store.playerMatches(key, clampLimit(limit, 50)).map(m => publicMatch(m, false)),
    };
  } catch (e) {
    logger.error('Leaderboard read failed:', e.message);
    return { player: null, matches: [] };
  }
}

function getRecentMatches(limit) {
  try {
    return db.getStore().recentMatches(clampLimit(limit, 50)).map(m => publicMatch(m, false));
  } catch (e) {
    logger.error('Leaderboard read failed:', e.message);
    return [];
  }
}

function getMatch(id) {
  try {
    const m = db.getStore().getMatch(id);
    return m ? publicMatch(m, true) : null;
  } catch (e) {
    logger.error('Leaderboard read failed:', e.message);
    return null;
  }
}

// Aggregate stats for /api/stats.
function getStats() {
  try {
    const counts = db.getStore().counts();
    const top = getLeaderboard(1)[0] || null;
    return {
      players: counts.players,
      matches: counts.matches,
      topPlayer: top ? top.name : null,
      topRating: top ? top.rating : null,
    };
  } catch (e) {
    logger.error('Leaderboard read failed:', e.message);
    return { players: 0, matches: 0, topPlayer: null, topRating: null };
  }
}

module.exports = {
  resolveIdentity,
  recordMatch,
  getLeaderboard,
  getPlayerMatches,
  getRecentMatches,
  getMatch,
  getStats,
};
