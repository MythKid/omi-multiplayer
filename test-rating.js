// Rating, grade and identity tests: the pure rules behind the leaderboard.
// Run with `npm test`.
const rating = require('./services/rating');
const identity = require('./services/identity');

let failures = 0;
function assert(cond, msg) { if (!cond) { failures++; console.log('  FAIL: ' + msg); } }
const near = (a, b, eps) => Math.abs(a - b) <= (eps || 1e-9);

console.log('rating tests\n');

// ---- names and keys ----
{
  assert(rating.playerKey('  Kamal   PERERA ') === 'kamal perera', 'keys are trimmed, collapsed, lowercased');
  assert(rating.playerKey('Ｋamal') === rating.playerKey('kamal'), 'full-width lookalikes share a key (NFKC)');
  ['Player', 'player 3', 'Guest', 'AI', 'bot2', 'x', ''].forEach(n =>
    assert(!rating.isRankableName(n), 'generic name "' + n + '" is not ranked'));
  ['Kamal', 'Nimali', 'Methindu', 'Player One Fan', 'කමල්'].forEach(n =>
    assert(rating.isRankableName(n), 'a real name "' + n + '" is ranked'));
  console.log('  names: keys and generic-name filter ok');
}

// ---- Elo pieces ----
{
  assert(near(rating.expectedScore(1200, 1200), 0.5), 'equal ratings expect 0.5');
  assert(near(rating.expectedScore(1600, 1200), 1 / (1 + Math.pow(10, -1))), '400 points apart expects ~0.909');
  assert(rating.kFactor(0) === 40 && rating.kFactor(9) === 40 && rating.kFactor(10) === 24, 'K is 40 while provisional, then 24');
  assert(rating.marginMultiplier(0) === 1 && rating.marginMultiplier(10) === 1.5 && rating.marginMultiplier(-14) === 1.5,
    'margin multiplier runs 1.0 to 1.5');
  assert(rating.lineupFactor(0) === 1 && rating.lineupFactor(1) === 0.5 && rating.lineupFactor(5) === 0.25,
    'repeat lineups decay 1, 0.5, 0.25');
  const lk = rating.lineupKey([
    { team: 0, key: 'b', ranked: true }, { team: 1, key: 'd', ranked: true },
    { team: 0, key: 'a', ranked: true }, { team: 1, key: 'c', ranked: true },
  ]);
  const lk2 = rating.lineupKey([
    { team: 1, key: 'a', ranked: true }, { team: 0, key: 'c', ranked: true },
    { team: 1, key: 'b', ranked: true }, { team: 0, key: 'd', ranked: true },
  ]);
  assert(lk === 'a&b vs c&d' && lk === lk2, 'lineup key ignores seat and side order');
  const withBot = rating.lineupKey([
    { team: 0, key: 'a', ranked: true }, { team: 1, key: null, ranked: false, isBot: true },
    { team: 0, key: 'p', ranked: false }, { team: 1, key: null, ranked: false, isBot: true },
  ]);
  assert(withBot === 'a&~guest vs ~bot&~bot', 'bots and unranked humans are placeholders (' + withBot + ')');
  console.log('  elo pieces: expected score, K, margin, decay, lineup ok');
}

// ---- rating deltas ----
{
  const human = (team, r, games) => ({ team, ranked: true, rating: r, games: games || 0 });
  const fixed = (team) => ({ team, ranked: false, rating: 0, games: 0 });

  // Four new players, team A wins 10-6: winners gain, losers lose, equally.
  let d = rating.ratingDeltas({
    seats: [human(0, 1200), human(1, 1200), human(0, 1200), human(1, 1200)],
    result: [1, 0], margin: 4, factor: 1, forfeit: false,
  });
  const expectWin = Math.round(40 * 1.2 * 0.5 * 10) / 10;
  assert(d[0] === expectWin && d[2] === expectWin && d[1] === -expectWin, 'even match: +/-' + expectWin + ' (got ' + d.join() + ')');

  // Bots never move and count as 1000.
  d = rating.ratingDeltas({
    seats: [human(0, 1200), fixed(1), fixed(0), fixed(1)],
    result: [1, 0], margin: 10, factor: 1, forfeit: false,
  });
  assert(d[1] === 0 && d[2] === 0 && d[3] === 0, 'bot seats never move');
  const vsBots = 40 * 1.5 * (1 - rating.expectedScore((1200 + 1000) / 2, 1000));
  assert(near(d[0], Math.round(vsBots * 10) / 10, 0.05), 'a human with a bot partner is rated on the team average');

  // Farming bots pays less and less as the rating climbs.
  const gainAt = r => rating.ratingDeltas({
    seats: [human(0, r, 50), fixed(1), human(0, r, 50), fixed(1)],
    result: [1, 0], margin: 10, factor: 1, forfeit: false,
  })[0];
  assert(gainAt(1200) > gainAt(1500) && gainAt(1500) > gainAt(1800) && gainAt(1800) < 3,
    'beating bots gains less as rating rises (' + [1200, 1500, 1800].map(gainAt).join(', ') + ')');

  // Upsets pay more than expected wins.
  const upset = rating.ratingDeltas({
    seats: [human(0, 1100, 30), human(1, 1500, 30), human(0, 1100, 30), human(1, 1500, 30)],
    result: [1, 0], margin: 1, factor: 1, forfeit: false,
  });
  const favourite = rating.ratingDeltas({
    seats: [human(0, 1500, 30), human(1, 1100, 30), human(0, 1500, 30), human(1, 1100, 30)],
    result: [1, 0], margin: 1, factor: 1, forfeit: false,
  });
  assert(upset[0] > favourite[0], 'an upset win pays more than a favoured win');

  // Repeat-lineup factor and forfeit multiplier.
  const decayed = rating.ratingDeltas({
    seats: [human(0, 1200), human(1, 1200), human(0, 1200), human(1, 1200)],
    result: [1, 0], margin: 4, factor: 0.25, forfeit: false,
  });
  assert(near(decayed[0], Math.round(expectWin * 0.25 * 10) / 10, 0.05), 'the repeat factor scales the change');
  const forfeit = rating.ratingDeltas({
    seats: [human(0, 1200), human(1, 1200), human(0, 1200), human(1, 1200)],
    result: [0, 1], margin: 9, factor: 1, forfeit: true,
  });
  assert(forfeit[0] === -20 && forfeit[1] === 20, 'a forfeit uses no margin bonus (' + forfeit.join() + ')');

  // Ratings never fall below the floor.
  const floored = rating.ratingDeltas({
    seats: [human(0, 105, 40), human(1, 2000, 40), human(0, 105, 40), human(1, 2000, 40)],
    result: [0, 1], margin: 10, factor: 1, forfeit: false,
  });
  assert(105 + floored[0] >= rating.RATING_FLOOR, 'ratings stop at the floor');
  console.log('  deltas: symmetry, bots fixed, farming, upsets, decay, forfeit, floor ok');
}

// ---- which ends count ----
{
  const c = rating.classifyEnd;
  let r = c({ endReason: 'completed', scores: [10, 6], roundsScored: 9 });
  assert(r.store && r.rated && r.result.join() === '1,0', 'a completed match is stored and rated');
  r = c({ endReason: 'vote', scores: [6, 3], roundsScored: 6 });
  assert(r.store && r.rated && r.result.join() === '1,0', 'vote end with the leader on 5+ is rated');
  r = c({ endReason: 'vote', scores: [3, 1], roundsScored: 3 });
  assert(r.store && !r.rated && r.note, 'vote end below 5 tokens is stored unrated, with a note');
  r = c({ endReason: 'vote', scores: [6, 6], roundsScored: 9 });
  assert(r.store && !r.rated && r.result.join() === '0.5,0.5', 'a level vote end is an unrated draw');
  r = c({ endReason: 'forfeit', scores: [1, 4], roundsScored: 3, leaverTeam: 1 });
  assert(r.store && r.rated && r.result.join() === '1,0', 'leaving after 2 rounds loses, even when ahead');
  r = c({ endReason: 'forfeit', scores: [0, 1], roundsScored: 1, leaverTeam: 0 });
  assert(!r.store && !r.rated, 'leaving in the first round is not recorded');
  console.log('  end rules: completed, vote (5+ / early / level), forfeit ok');
}

// ---- stats and grades ----
{
  const teams = [0, 1, 0, 1];
  const history = [
    // seat 1 (team B) calls and makes it 5-3
    { type: 'round', callerSeat: 1, tricksBySeat: [2, 3, 1, 2], outcome: 'call-made', kapothiTeam: -1 },
    { type: 'redeal', counts: [1, 7], shortTeam: 0 },
    // seat 2 (team A) calls, breaks: team B takes 5
    { type: 'round', callerSeat: 2, tricksBySeat: [1, 3, 2, 2], outcome: 'call-broken', kapothiTeam: -1 },
    // team A announces and sweeps
    { type: 'round', callerSeat: 3, tricksBySeat: [4, 0, 4, 0], outcome: 'kapothi-made', kapothiTeam: 0 },
  ];
  const st = rating.deriveMatchStats(history, teams);
  assert(st.totalTricks === 24 && st.redeals === 1, 'totals: 24 tricks, 1 redeal');
  assert(st.seats[0].tricks === 7 && st.seats[1].tricks === 6, 'tricks per seat');
  assert(st.seats[1].calls === 1 && st.seats[1].callsMade === 1, 'seat 1 made its call');
  assert(st.seats[2].calls === 1 && st.seats[2].callsMade === 0, 'seat 2 was broken');
  assert(st.seats[1].defences === 1 && st.seats[1].breaks === 1, 'team B broke the call it defended');
  assert(st.seats[0].defences === 2 && st.seats[0].breaks === 1, 'team A defended twice, broke once (the sweep)');
  assert(st.seats[0].kapothiMade === 1 && st.seats[1].kapothiMade === 0, 'Kapothi credited to the announcing team');

  const g = rating.gradeFor({ result: 1, tokens: 10, oppTokens: 0, stat: st.seats[0], totalTricks: 24, forfeited: false });
  assert(g.score >= 0 && g.score <= 100 && g.letter === rating.gradeLetter(g.score), 'grade is a bounded score with its letter');
  const lose = rating.gradeFor({ result: 0, tokens: 0, oppTokens: 10, stat: st.seats[1], totalTricks: 24, forfeited: false });
  assert(g.score > lose.score, 'a dominant win grades above a shut-out loss');
  const quit = rating.gradeFor({ result: 0, tokens: 5, oppTokens: 2, stat: st.seats[0], totalTricks: 24, forfeited: true });
  assert(quit.letter === 'F' && quit.score === 0, 'a leaver is graded F');
  const empty = { rounds: 0, tricks: 0, calls: 0, callsMade: 0, defences: 0, breaks: 0, kapothiMade: 0, kapothiBroken: 9 };
  const clamp = rating.gradeFor({ result: 0, tokens: 0, oppTokens: 0, stat: empty, totalTricks: 0, forfeited: false });
  assert(clamp.score >= 0, 'grades never go below 0');
  assert(['S', 'A', 'B', 'C', 'D', 'E'].join() === [95, 80, 70, 55, 40, 10].map(rating.gradeLetter).join(), 'letter bands');
  console.log('  stats and grades: tricks, calls, breaks, Kapothi, letters, forfeit ok');
}

// ---- identity claims ----
{
  const s1 = identity.newSecret();
  const s2 = identity.newSecret();
  assert(identity.isWellFormed(s1) && s1 !== s2, 'secrets are well formed and unique');
  const h = identity.hashSecret(s1);
  assert(/^[0-9a-f]{64}$/.test(h) && h !== s1, 'only a SHA-256 hash is stored');
  assert(identity.verify(s1, h), 'the right secret verifies');
  assert(!identity.verify(s2, h), 'another secret does not');
  assert(!identity.verify('short', h) && !identity.verify(null, h) && !identity.verify(s1, 'nothex'),
    'malformed secrets or hashes never verify');
  console.log('  identity: issue, hash, verify, reject ok');
}

console.log(failures === 0 ? '\nRATING TESTS PASSED' : '\n' + failures + ' FAILURES');
process.exit(failures === 0 ? 0 : 1);
