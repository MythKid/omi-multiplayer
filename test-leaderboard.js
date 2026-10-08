// Leaderboard tests: identity claims, recording real matches, ratings and
// grades end to end, the rules for what counts, history and match detail,
// persistence across a reload, and that legacy data is left alone. Runs once
// per storage driver (SQLite and JSON), each in an isolated temp directory.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

// Parent process: run this file once per driver and report.
if (!process.env.OMI_LB_DRIVER) {
  console.log('leaderboard tests\n');
  let failed = 0;
  for (const driver of ['sqlite', 'json']) {
    const r = spawnSync(process.execPath, [__filename], {
      env: Object.assign({}, process.env, { OMI_LB_DRIVER: driver }),
      encoding: 'utf8',
    });
    process.stdout.write(r.stdout || '');
    process.stdout.write(r.stderr || '');
    if (r.status !== 0) failed++;
  }
  console.log(failed === 0 ? '\nLEADERBOARD TESTS PASSED' : '\n' + failed + ' DRIVER RUN(S) FAILED');
  process.exit(failed === 0 ? 0 : 1);
}

const DRIVER = process.env.OMI_LB_DRIVER;
const TMP = path.join(os.tmpdir(), 'omi-lb-test-' + DRIVER + '-' + Date.now());
process.env.DATA_DIR = TMP;       // isolate storage (read before config loads)
process.env.DB_DRIVER = DRIVER;
process.env.LOG_LEVEL = 'error';  // keep the output clean
fs.mkdirSync(TMP, { recursive: true });

// Legacy data from the best-score leaderboard must survive untouched.
if (DRIVER === 'sqlite') {
  const Database = require('better-sqlite3');
  const legacy = new Database(path.join(TMP, 'leaderboard.db'));
  legacy.exec('CREATE TABLE scores (team TEXT PRIMARY KEY, score INTEGER NOT NULL, date TEXT NOT NULL)');
  legacy.prepare('INSERT INTO scores VALUES (?, ?, ?)').run('Old + Team', 12, '2026-01-01T00:00:00.000Z');
  legacy.close();
} else {
  fs.writeFileSync(path.join(TMP, 'leaderboard.json'), JSON.stringify([{ team: 'Old + Team', score: 12, date: 'x' }]));
}

const game = require('./game');
const lb = require('./services/leaderboardService');
const db = require('./database');

let failures = 0;
function assert(cond, msg) { if (!cond) { failures++; console.log('  [' + DRIVER + '] FAIL: ' + msg); } }
const log = (m) => console.log('  [' + DRIVER + '] ' + m);

// Play a full 4p game with bots driving every seat, for a real round log.
function playGame() {
  const gs = game.createGame([{ id: 'x', name: 'Host', seat: 0 }], 4);
  const ent = () => Array.from({ length: 64 }, () => Math.random() * 1e6);
  let guard = 0;
  while (!gs.gameOver && guard++ < 6000) {
    if (gs.phase === 'shuffle') {
      game.applyShuffle(gs, { entropy: ent(), washMs: 3000, ops: [{ t: 'r' }, { t: 'r' }, { t: 'r' }] });
    } else if (gs.phase === 'cut') game.applyCut(gs, [[13, 32], [0, 13]]);
    else if (gs.phase === 'dealing1') game.dealStage1(gs);
    else if (gs.phase === 'trump') game.chooseTrump(gs, game.aiPickTrump(gs, gs.currentSeat));
    else if (gs.phase === 'dealing2') game.dealStage2(gs);
    else if (gs.phase === 'redeal') game.redealRound(gs);
    else if (gs.phase === 'kapothi') game.decideKapothi(gs, game.aiDecideKapothi(gs, gs.currentSeat));
    else if (gs.roundJustEnded) game.nextRound(gs);
    else {
      game.playCard(gs, gs.currentSeat, game.aiPickCard(gs, gs.currentSeat));
      if (gs.trickJustEnded) game.endTrick(gs);
    }
  }
  return gs;
}

// A table's snapshot of a finished game, with the given humans seated.
//   people: per seat, a name (human) or null (bot)
function snapshot(gs, people, ids, endReason, leaverSeat) {
  return {
    tableId: 1,
    endReason: endReason || 'completed',
    leaverSeat: leaverSeat == null ? -1 : leaverSeat,
    history: gs.history,
    players: gs.players.map((p, seat) => ({
      seat,
      name: people[seat] || p.name,
      team: p.team,
      isBot: !people[seat],
      score: p.score,
      identity: people[seat] ? ids[people[seat]] : null,
    })),
  };
}

// ---- identity ----
const ids = {};
{
  const generic = lb.resolveIdentity('Player 2');
  assert(!generic.rankable && generic.reason === 'generic' && !generic.secret, 'generic names are not ranked');
  ['Kamal', 'Nimal', 'Sunil', 'Ruwan'].forEach(n => { ids[n] = lb.resolveIdentity(n); });
  assert(Object.values(ids).every(i => i.rankable && i.issued && i.secret), 'new names get a freshly issued claim');
  const adopt = lb.resolveIdentity('Tharushi', ids.Kamal.secret);
  assert(adopt.rankable && !adopt.issued && adopt.secret === ids.Kamal.secret, 'an unregistered name adopts the claim the browser sent');
  log('identity: generic, issued, adopted ok');
}

// ---- a full completed match ----
let first;
{
  const gs = playGame();
  assert(gs.gameOver, 'the sample game finished');
  const people = ['Kamal', 'Nimal', 'Sunil', 'Ruwan'];
  first = lb.recordMatch(snapshot(gs, people, ids));
  assert(first && first.id && first.rated, 'a completed 4-human match is stored and rated');
  assert(first.seats.every(s => s.rated && s.grade && s.gradeScore >= 0 && s.gradeScore <= 100), 'every human is rated and graded');
  const sum = first.seats.reduce((a, s) => a + s.delta, 0);
  assert(Math.abs(sum) < 0.5, 'an even first match is zero-sum (' + sum + ')');
  const winTeam = gs.players.find(p => p.score >= 10).team;
  assert(first.seats.every(s => (s.team === winTeam) === (s.delta > 0)), 'winners gain, losers lose');

  const board = lb.getLeaderboard(10);
  assert(board.length === 4 && board[0].rating >= board[3].rating, 'four players ranked, best first');
  assert(board.every((r, i) => r.rank === i + 1), 'ranks run 1..n');
  assert(board.every(r => r.games === 1 && r.provisional && r.avgGrade), 'records show games, provisional tag and grade');
  assert(!/claim/i.test(JSON.stringify(board)), 'claim hashes never leave the server');
  log('completed match: rated, graded, zero-sum, ranked ok');
}

// ---- claims are now registered ----
{
  const mine = lb.resolveIdentity('KAMAL', ids.Kamal.secret);
  assert(mine.rankable && !mine.issued, 'the claim holder keeps their name (any case)');
  const thief = lb.resolveIdentity('Kamal', ids.Nimal.secret);
  assert(!thief.rankable && thief.reason === 'claimed', 'someone else under a registered name is not ranked');
  const noClaim = lb.resolveIdentity('Kamal');
  assert(!noClaim.rankable && noClaim.reason === 'claimed', 'no claim for a registered name is not ranked');
  log('claims: holder ok, impostors refused');
}

// ---- impersonation caught at record time, plus repeat-lineup decay ----
{
  const before = lb.getLeaderboard(10).find(r => r.name === 'Kamal');
  const gs = playGame();
  const forged = Object.assign({}, ids, { Kamal: { key: 'kamal', rankable: true, secret: ids.Nimal.secret } });
  const rec = lb.recordMatch(snapshot(gs, ['Kamal', 'Nimal', 'Sunil', 'Ruwan'], forged));
  const kamalSeat = rec.seats.find(s => s.name === 'Kamal');
  assert(rec && !kamalSeat.rated && kamalSeat.reason === 'claimed', 'a forged claim is caught when the match is recorded');
  const after = lb.getLeaderboard(10).find(r => r.name === 'Kamal');
  assert(after.games === before.games && after.rating === before.rating, 'the real Kamal is untouched by the impostor');

  // Same four ranked people again: the lineup now differs (Kamal unranked),
  // so play the identical lineup twice more and compare.
  const people = ['Kamal', 'Nimal', 'Sunil', 'Ruwan'];
  const g1 = playGame();
  const r1 = lb.recordMatch(snapshot(g1, people, ids));
  const g2 = playGame();
  const r2 = lb.recordMatch(snapshot(g2, people, ids));
  const mag = r => r.seats.reduce((a, s) => a + Math.abs(s.delta), 0);
  const margin = gs => Math.abs(gs.players[0].score - gs.players[1].score);
  // Normalise by the margin multiplier so only the repeat factor differs.
  const norm = (r, gs) => mag(r) / (1 + Math.min(margin(gs), 10) / 20);
  assert(norm(r2, g2) < norm(r1, g1), 'the same lineup again within a day moves ratings less');
  log('record-time verification and repeat-lineup decay ok');
}

// ---- what counts: vote, forfeit, bots, unranked ----
{
  const gamesOf = n => (lb.getLeaderboard(50).find(r => r.name === n) || { games: 0 }).games;
  const people = ['Kamal', 'Nimal', 'Sunil', 'Ruwan'];

  // An early agreed end below 5 tokens is kept as history but not rated.
  const early = playGame();
  early.players.forEach(p => { p.score = p.team === 0 ? 3 : 1; });
  const g0 = gamesOf('Kamal');
  const voted = lb.recordMatch(snapshot(early, people, ids, 'vote'));
  assert(voted && !voted.rated && voted.note && voted.seats.every(s => !s.rated && s.delta === 0),
    'an early vote end is stored unrated with a note');
  assert(gamesOf('Kamal') === g0, 'an unrated match does not count as a game');

  // Leaving after 2+ rounds loses for the leaver's team; the leaver gets F.
  const quit = playGame();
  const leaver = 1; // Nimal, team B
  const forfeit = lb.recordMatch(snapshot(quit, people, ids, 'forfeit', leaver));
  assert(forfeit && forfeit.rated, 'a forfeit after 2 rounds is rated');
  assert(forfeit.seats.filter(s => s.team === 1).every(s => s.delta < 0), "the leaver's team loses rating");
  assert(forfeit.seats[leaver].grade === 'F', 'the leaver is graded F');

  // Leaving in the first round is not recorded at all.
  const fresh = game.createGame([{ id: 'x', name: 'H', seat: 0 }], 4);
  assert(lb.recordMatch(snapshot(fresh, people, ids, 'forfeit', 0)) === null, 'an early forfeit is not recorded');

  // Humans with bots: only the humans move; bots stay keyless.
  ids.Ama = lb.resolveIdentity('Ama');
  const solo = playGame();
  const withBots = lb.recordMatch(snapshot(solo, ['Ama', null, null, null], ids));
  assert(withBots && withBots.rated && withBots.seats[0].rated, 'a human playing with bots is rated');
  assert(withBots.seats.slice(1).every(s => s.isBot && s.key === null && s.delta === 0 && s.grade === null),
    'bots are recorded without a key, rating or grade');

  // Nobody ranked at the table: nothing is stored.
  const anon = playGame();
  const generic = { 'Player': lb.resolveIdentity('Player') };
  assert(lb.recordMatch(snapshot(anon, ['Player', null, null, null], generic)) === null,
    'a match with no ranked player is not stored');
  log('vote, forfeit, early forfeit, bots, unranked ok');
}

// ---- history and match detail ----
{
  const res = lb.getPlayerMatches('kamal', 50);
  assert(res.player && res.player.name === 'Kamal', 'player profile by name');
  assert(res.matches.length >= 4 && res.matches.every(m => m.seats.length === 4), 'history lists every seat (partner and opponents)');
  assert(res.matches[0].id > res.matches[res.matches.length - 1].id, 'history is newest first');
  const detail = lb.getMatch(first.id);
  const rounds = detail.timeline.filter(t => t.type === 'round');
  assert(detail && rounds.length === detail.rounds, 'the timeline has one entry per round');
  assert(detail.timeline.filter(t => t.type === 'redeal').length === detail.redeals, 'redeals appear in the timeline');
  assert(rounds.every(t => t.tricks[0] + t.tricks[1] === 8 && t.scoreAfter.length === 2), 'each round shows tricks and score');
  assert(lb.getMatch(999999) === null, 'an unknown match id is null');
  assert(lb.getRecentMatches(3).length === 3, 'recent matches respect the limit');
  const stats = lb.getStats();
  assert(stats.players >= 5 && stats.matches >= 6 && stats.topPlayer, 'stats count players and matches');
  log('history, match timeline, recent, stats ok');
}

// ---- persistence across a store reload (simulates a restart) ----
{
  const before = JSON.stringify(lb.getLeaderboard(50));
  db.closeStore();
  const after = JSON.stringify(lb.getLeaderboard(50));
  assert(before === after, 'the board survives a store reload');
  assert(lb.resolveIdentity('Kamal', ids.Kamal.secret).rankable, 'claims survive a store reload');
  db.closeStore();
  log('persistence ok');
}

// ---- legacy data untouched ----
if (DRIVER === 'sqlite') {
  const Database = require('better-sqlite3');
  const check = new Database(path.join(TMP, 'leaderboard.db'), { readonly: true });
  const rows = check.prepare('SELECT * FROM scores').all();
  check.close();
  assert(rows.length === 1 && rows[0].team === 'Old + Team', 'the legacy scores table is left as it was');
} else {
  const legacy = JSON.parse(fs.readFileSync(path.join(TMP, 'leaderboard.json'), 'utf8'));
  assert(Array.isArray(legacy) && legacy[0].team === 'Old + Team', 'the legacy JSON file is left as it was');
}
log('legacy data untouched');

try { db.closeStore(); } catch (e) {}
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}

log(failures === 0 ? 'all checks passed' : failures + ' FAILURES');
process.exit(failures === 0 ? 0 : 1);
