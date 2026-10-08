// Ratings and grades for 4-player matches. Pure functions, no storage.
//
// Rating: Elo for individuals playing in pairs. A team's strength is the
// average of its two seats; each rated player then moves by
//   K * margin * repeat * (result - expected).
// Bots, and humans whose name cannot be ranked, sit at a fixed rating that
// never moves, so beating them pays less and less as a player climbs.
//
// Grade: a 0-100 score for how one player's match went (result, tokens,
// tricks, their own trump calls, defending, Kapothi), shown as a letter.
const { nameKey } = require('../utils/sanitize');

const START_RATING = 1200;
const FIXED_RATING = 1000;     // bots and unranked humans
const RATING_FLOOR = 100;
const PROVISIONAL_GAMES = 10;  // higher K while a rating settles
const K_PROVISIONAL = 40;
const K_ESTABLISHED = 24;
const VOTE_MIN_TOKENS = 5;     // a vote-ended match counts only from here
const FORFEIT_MIN_ROUNDS = 2;  // leaving after this many rounds is a loss
const LINEUP_WINDOW_MS = 24 * 60 * 60 * 1000;

// Names that clearly are not a person's own, so they are never ranked
// (otherwise every stranger called "Player" would share one rating).
const GENERIC_NAME = /^(player|guest|anon|anonymous|user|test|tester|ai|bot|cpu|computer|you|me|name|someone|nobody|admin)( ?\d+)?$/;

function playerKey(name) {
  return nameKey(name);
}

function isRankableName(name) {
  const key = playerKey(name);
  return key.length >= 2 && !GENERIC_NAME.test(key);
}

function expectedScore(own, opp) {
  return 1 / (1 + Math.pow(10, (opp - own) / 400));
}

function kFactor(games) {
  return games < PROVISIONAL_GAMES ? K_PROVISIONAL : K_ESTABLISHED;
}

// A bigger winning margin moves ratings a little more: 1.0 up to 1.5.
function marginMultiplier(margin) {
  return 1 + Math.min(Math.abs(margin), 10) / 20;
}

// The same four people playing again and again within a day count less
// each time, so a lineup cannot be farmed: 1, then 0.5, then 0.25.
function lineupFactor(priorMatches) {
  if (priorMatches <= 0) return 1;
  if (priorMatches === 1) return 0.5;
  return 0.25;
}

// Order-independent identity of the four seats, e.g. "a&b vs c&d". Bots and
// unranked humans appear as placeholders so they never form a lineup.
function lineupKey(seats) {
  const label = s => (s.ranked ? s.key : s.isBot ? '~bot' : '~guest');
  const teams = [0, 1].map(t => seats.filter(s => s.team === t).map(label).sort().join('&'));
  return teams.sort().join(' vs ');
}

// Decide whether a finished or abandoned match is stored and rated, and the
// result for each team (1 win, 0.5 draw, 0 loss).
//   endReason: 'completed' | 'vote' | 'forfeit'
function classifyEnd({ endReason, scores, roundsScored, leaverTeam }) {
  const [a, b] = scores;
  const byScore = a > b ? [1, 0] : b > a ? [0, 1] : [0.5, 0.5];
  if (endReason === 'completed') {
    return { store: true, rated: true, result: byScore, note: '' };
  }
  if (endReason === 'vote') {
    const tied = a === b;
    const rated = !tied && Math.max(a, b) >= VOTE_MIN_TOKENS;
    return {
      store: true,
      rated,
      result: byScore,
      note: rated ? '' : (tied ? 'Ended early with the scores level, so it is not ranked'
        : `Ended early before ${VOTE_MIN_TOKENS} tokens, so it is not ranked`),
    };
  }
  if (endReason === 'forfeit') {
    if (roundsScored < FORFEIT_MIN_ROUNDS || (leaverTeam !== 0 && leaverTeam !== 1)) {
      return { store: false, rated: false, result: [0.5, 0.5], note: '' };
    }
    const result = leaverTeam === 0 ? [0, 1] : [1, 0];
    return { store: true, rated: true, result, note: '' };
  }
  return { store: false, rated: false, result: [0.5, 0.5], note: '' };
}

// Per-seat statistics from the round log (game.js gs.history).
//   seatsTeams: team of each seat, e.g. [0, 1, 0, 1]
function deriveMatchStats(history, seatsTeams) {
  const stats = seatsTeams.map(() => ({
    rounds: 0, tricks: 0, calls: 0, callsMade: 0, defences: 0, breaks: 0,
    kapothiMade: 0, kapothiBroken: 0,
  }));
  let totalTricks = 0;
  let redeals = 0;
  (history || []).forEach(h => {
    if (h.type === 'redeal') { redeals++; return; }
    if (h.type !== 'round' || !Array.isArray(h.tricksBySeat)) return;
    const callerTeam = seatsTeams[h.callerSeat];
    const teamTricks = [0, 1].map(t =>
      h.tricksBySeat.reduce((sum, n, seat) => sum + (seatsTeams[seat] === t ? n : 0), 0));
    totalTricks += teamTricks[0] + teamTricks[1];
    stats.forEach((st, seat) => {
      const team = seatsTeams[seat];
      st.rounds++;
      st.tricks += h.tricksBySeat[seat] || 0;
      if (h.callerSeat === seat) {
        st.calls++;
        if (teamTricks[team] >= 5) st.callsMade++;
      }
      if (team !== callerTeam) {
        st.defences++;
        if (teamTricks[team] >= 5) st.breaks++;
      }
      if (h.kapothiTeam === team) {
        if (h.outcome === 'kapothi-made') st.kapothiMade++;
        else if (h.outcome === 'kapothi-broken') st.kapothiBroken++;
      }
    });
  });
  return { seats: stats, totalTricks, redeals };
}

function gradeLetter(score) {
  if (score >= 90) return 'S';
  if (score >= 78) return 'A';
  if (score >= 64) return 'B';
  if (score >= 50) return 'C';
  if (score >= 36) return 'D';
  return 'E';
}

// One player's performance score (0-100) and letter.
function gradeFor({ result, tokens, oppTokens, stat, totalTricks, forfeited }) {
  if (forfeited) return { score: 0, letter: 'F' };
  const tokenShare = tokens + oppTokens > 0 ? tokens / (tokens + oppTokens) : 0.5;
  const trickShare = totalTricks > 0 ? stat.tricks / totalTricks : 0.25;
  const callRate = stat.calls > 0 ? stat.callsMade / stat.calls : 0.5;
  const breakRate = stat.defences > 0 ? stat.breaks / stat.defences : 0.5;
  const raw = 30 * result
    + 20 * tokenShare
    + 20 * Math.min(1, trickShare / 0.5)
    + 15 * callRate
    + 10 * breakRate
    + 5 * stat.kapothiMade
    - 5 * stat.kapothiBroken;
  const score = Math.round(Math.max(0, Math.min(100, raw)));
  return { score, letter: gradeLetter(score) };
}

// Rating changes for one match.
//   seats: [{ team, ranked, rating, games }] (unranked/bot seats are fixed)
// Returns the delta for each seat (0 for fixed seats), rounded to 0.1.
function ratingDeltas({ seats, result, margin, factor, forfeit }) {
  const strength = t => {
    const members = seats.filter(s => s.team === t);
    return members.reduce((sum, s) => sum + (s.ranked ? s.rating : FIXED_RATING), 0) / members.length;
  };
  const teamRating = [strength(0), strength(1)];
  const m = forfeit ? 1 : marginMultiplier(margin);
  return seats.map(s => {
    if (!s.ranked) return 0;
    const own = teamRating[s.team];
    const opp = teamRating[1 - s.team];
    const raw = kFactor(s.games) * m * factor * (result[s.team] - expectedScore(own, opp));
    const delta = Math.round(raw * 10) / 10;
    // The floor applies to the new rating, so report the change actually made.
    return Math.round((Math.max(RATING_FLOOR, s.rating + delta) - s.rating) * 10) / 10;
  });
}

module.exports = {
  START_RATING,
  FIXED_RATING,
  RATING_FLOOR,
  VOTE_MIN_TOKENS,
  FORFEIT_MIN_ROUNDS,
  LINEUP_WINDOW_MS,
  playerKey,
  isRankableName,
  expectedScore,
  kFactor,
  marginMultiplier,
  lineupFactor,
  lineupKey,
  classifyEnd,
  deriveMatchStats,
  gradeLetter,
  gradeFor,
  ratingDeltas,
};
