// Test suite for game.js: rules, the physical shuffle model, scoring,
// and full AI-vs-AI games for every mode. Run with `npm test`.
const game = require('./game');

let failures = 0;
function assert(cond, msg) {
  if (!cond) { failures++; console.log('  FAIL: ' + msg); }
}
const key = c => c.s + c.r;
const randEntropy = () => Array.from({ length: 64 }, () => Math.random() * 1e6);

// A thorough human shuffle: wash + overhand pass + three riffles
const shuf = gs => game.applyShuffle(gs, {
  entropy: randEntropy(),
  washMs: 3000,
  ops: [{ t: 'o', packets: [6, 9, 5, 12] }, { t: 'r' }, { t: 'r' }, { t: 'r' }],
});

// Small deterministic PRNG for direct riffle/overhand checks
function mulberry(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Shuffle, cut, deal and call trump until the hand is playable. A trump
// shortage (either team holding fewer than 2) throws the hand in for a redeal.
function dealToPlay(gs, trump) {
  for (let attempt = 0; attempt < 50; attempt++) {
    shuf(gs);
    game.applyCut(gs, [[16, 32], [0, 16]]);
    game.dealStage1(gs);
    game.chooseTrump(gs, trump || '♠');
    game.dealStage2(gs);
    if (gs.phase === 'play') return gs;
    game.redealRound(gs);
  }
  throw new Error('no playable deal in 50 attempts');
}

console.log('game.js tests\n');

// ---- beats() truth table ----
{
  const T = '♠', L = '♥';
  const c = (s, r) => ({ s, r, v: game.RV[r] });
  assert(game.beats(c(T, '7'), c(L, 'A'), T, L) === true, 'trump beats non-trump');
  assert(game.beats(c(L, 'A'), c(T, '7'), T, L) === false, 'non-trump loses to trump');
  assert(game.beats(c(L, 'K'), c(L, 'Q'), T, L) === true, 'same suit, higher wins');
  assert(game.beats(c('♦', 'A'), c(L, '7'), T, L) === false, 'off-suit loses to lead');
  console.log('  beats(): truth table ok');
}

// ---- shuffle determinism + payload validation ----
{
  const newGame = () => game.createGame([{ id: 'x', name: 'H', seat: 0 }], 4);
  const ent = randEntropy();
  const payload = () => ({
    entropy: ent.slice(),
    washMs: 2500,
    ops: [{ t: 'o', packets: [5, 9, 11, 7] }, { t: 'r' }],
  });
  const gs1 = newGame();
  const gs2 = newGame();
  game.applyShuffle(gs1, payload());
  game.applyShuffle(gs2, payload());
  assert(gs1.deck.map(key).join() === gs2.deck.map(key).join(), 'same payload gives same deck');
  const gs3 = newGame();
  game.applyShuffle(gs3, { entropy: randEntropy(), washMs: 2500, ops: payload().ops });
  assert(gs1.deck.map(key).join() !== gs3.deck.map(key).join(), 'different entropy gives different order');

  let threw = 0;
  [
    { entropy: ent, washMs: 0, ops: [] },
    { entropy: ent, washMs: 0, ops: [{ t: 'x' }] },
    { entropy: ent, washMs: 0, ops: [{ t: 'o', packets: [10, 10] }] },
    { entropy: ent, washMs: 0, ops: [{ t: 'o', packets: [0, 32] }] },
    { entropy: [1, 2], washMs: 0, ops: [{ t: 'r' }] },
  ].forEach(p => { try { game.applyShuffle(newGame(), p); } catch (e) { threw++; } });
  assert(threw === 5, 'bad shuffle payloads throw (' + threw + '/5)');
  console.log('  applyShuffle: deterministic, validation ok');
}

// ---- physical mixing model ----
{
  // One GSR riffle of a sorted deck interleaves two increasing runs, so the
  // result has at most 2 rising sequences of the original order.
  const risingSeqs = labels => {
    const pos = [];
    labels.forEach((v, i) => { pos[v] = i; });
    let seqs = 1;
    for (let v = 1; v < labels.length; v++) if (pos[v] < pos[v - 1]) seqs++;
    return seqs;
  };
  const rand = mulberry(12345);
  for (let i = 0; i < 100; i++) {
    const sorted = Array.from({ length: 32 }, (_, v) => v);
    const once = game.riffleOnce(sorted, rand);
    assert(risingSeqs(once) <= 2, 'riffle ' + i + ': more than 2 rising sequences');
    assert(once.length === 32 && new Set(once).size === 32, 'riffle keeps all cards');
  }

  // Overhand: packets come off the top in reverse order, intact inside
  const sorted = Array.from({ length: 32 }, (_, v) => v);
  const oh = game.overhandOnce(sorted, [5, 7, 10, 10]);
  const expected = []
    .concat(sorted.slice(22, 32), sorted.slice(12, 22), sorted.slice(5, 12), sorted.slice(0, 5));
  assert(oh.join() === expected.join(), 'overhand reverses packet blocks');
  assert(game.overhandOnce(sorted, [32]).join() === sorted.join(), 'single-packet pass is identity');

  // Wash: partial, and scaled by wash time
  const displacement = (gs, ref) => {
    const idx = {};
    ref.forEach((c, i) => { idx[key(c)] = i; });
    return gs.deck.reduce((s, c, i) => s + Math.abs(idx[key(c)] - i), 0) / gs.deck.length;
  };
  const fixedEnt = Array.from({ length: 64 }, (_, i) => (i * 7919) % 1000);
  const washOnly = ms => {
    const gs = game.createGame([{ id: 'x', name: 'H', seat: 0 }], 4);
    const ref = gs.deck.slice();
    game.applyShuffle(gs, { entropy: fixedEnt, washMs: ms, ops: [{ t: 'o', packets: [32] }] });
    return { gs, ref };
  };
  const w0 = washOnly(0);
  assert(displacement(w0.gs, w0.ref) === 0, 'washMs 0 leaves the deck untouched');
  const wShort = washOnly(800);
  const wLong = washOnly(12000);
  const dShort = displacement(wShort.gs, wShort.ref);
  const dLong = displacement(wLong.gs, wLong.ref);
  assert(dShort > 0, 'short wash stirs a little');
  assert(dLong > dShort, 'longer wash mixes more');

  // Realism: ONE riffle of a factory-fresh suit-blocked deck keeps heavy
  // suit clumping. A perfect shuffle would destroy it.
  const gsClump = game.createGame([{ id: 'x', name: 'H', seat: 0 }], 4);
  game.applyShuffle(gsClump, { entropy: fixedEnt, washMs: 0, ops: [{ t: 'r' }] });
  let sameSuitAdj = 0;
  for (let i = 1; i < gsClump.deck.length; i++) {
    if (gsClump.deck[i].s === gsClump.deck[i - 1].s) sameSuitAdj++;
  }
  assert(sameSuitAdj > 15, 'one riffle leaves suit runs (' + sameSuitAdj + ' adjacent pairs)');
  console.log('  mixing model: GSR, overhand, scaled wash, clumping ok');
}

// ---- cut mechanics ----
{
  const gs = game.createGame([{ id: 'x', name: 'H', seat: 0 }], 4);
  shuf(gs);
  const before = gs.deck.slice();
  game.applyCut(gs, [[10, 32], [0, 10]]);
  assert(gs.deck.length === 32, 'cut keeps 32 cards');
  assert(key(gs.deck[0]) === key(before[10]), 'cut: card 10 becomes the top');
  assert(key(gs.deck[31]) === key(before[9]), 'cut: old top section moves under');
  assert(gs.phase === 'dealing1', 'cut leads into dealing');

  const gs2 = game.createGame([{ id: 'x', name: 'H', seat: 0 }], 4);
  shuf(gs2);
  let threw = 0;
  [[[0, 32]], [[0, 10], [12, 32]], [[0, 10], [10, 30]], [[0, 20], [10, 32]], 'junk']
    .forEach(seg => { try { game.applyCut(gs2, seg); } catch (e) { threw++; } });
  assert(threw === 5, 'invalid cuts throw (' + threw + '/5)');
  console.log('  applyCut: reorder, validation ok');
}

// ---- roles, two-stage deal, trick collection, deck rebuild ----
{
  const gs = game.createGame([{ id: 'x', name: 'Host', seat: 0 }], 4);
  const identity = new Set(gs.deck);
  assert(gs.phase === 'shuffle' && gs.currentSeat === gs.dealer, 'round opens in shuffle phase');
  assert(gs.trumpCallerSeat === (gs.dealer + 1) % 4, 'trump caller is next to the dealer');
  assert(gs.breakerSeat === (gs.dealer + 3) % 4, 'breaker is on the other side');

  // Repeat the deal if a trump shortage throws the hand in (about 1 in 27).
  for (let attempt = 0; attempt < 50; attempt++) {
    shuf(gs);
    assert(gs.currentSeat === gs.breakerSeat, 'breaker acts in the cut phase');
    game.applyCut(gs, [[14, 32], [0, 14]]);
    const postCutDeck = gs.deck.slice();

    game.dealStage1(gs);
    assert(gs.phase === 'trump' && gs.currentSeat === gs.trumpCallerSeat, 'stage 1 hands the choice to the caller');
    gs.players.forEach(p => assert(p.hand.length === 4, 'stage 1: 4 cards each'));
    const callerGot = gs.players[gs.trumpCallerSeat].hand.map(key).sort().join();
    const expected = postCutDeck.slice(0, 4).map(key).sort().join();
    assert(callerGot === expected, 'trump caller got the top 4 cards');

    game.chooseTrump(gs, game.aiPickTrump(gs, gs.trumpCallerSeat));
    assert(gs.phase === 'dealing2', 'trump lock leads to the second deal');
    game.dealStage2(gs);
    if (gs.phase !== 'redeal') break;
    game.redealRound(gs);
  }
  assert(gs.phase === 'play' && gs.currentSeat === gs.trumpCallerSeat, 'caller leads the first trick');
  gs.players.forEach(p => assert(p.hand.length === 8, 'stage 2: 8 cards each'));
  assert(gs.deck.length === 0, 'deck empty after the full deal');

  const playedTricks = [];
  let currentTrick = [];
  let guard = 0;
  while (!gs.roundJustEnded && guard++ < 200) {
    if (gs.phase === 'kapothi') { game.decideKapothi(gs, false); continue; }
    game.playCard(gs, gs.currentSeat, game.aiPickCard(gs, gs.currentSeat));
    currentTrick.push(gs.trick[gs.trick.length - 1].card);
    if (gs.trickJustEnded) {
      playedTricks.push(currentTrick);
      currentTrick = [];
      game.endTrick(gs);
    }
  }
  assert(gs.roundJustEnded, 'round completes');
  assert(playedTricks.length === 8, '8 tricks collected');

  // End of round: sub-stacks pile up in the order they were won, first at
  // the bottom. deck[0] is the top, meaning the last card of the last trick.
  const bottomUp = [];
  playedTricks.forEach(t => t.forEach(cd => bottomUp.push(cd)));
  const expectedDeck = bottomUp.reverse().map(key).join();
  assert(gs.deck.map(key).join() === expectedDeck, 'deck rebuilt from tricks in won order');
  assert(gs.deck.length === 32 && new Set(gs.deck.map(key)).size === 32, 'rebuilt deck intact');
  gs.deck.forEach(cd => assert(identity.has(cd), 'the same physical card objects persist'));

  const prevDealer = gs.dealer;
  game.nextRound(gs);
  assert(gs.dealer === (prevDealer + 1) % 4, 'deal passes to the next player');
  assert(gs.phase === 'shuffle', 'next round opens in shuffle phase');
  assert(gs.deck.map(key).join() === expectedDeck, 'nextRound does not touch the deck');
  console.log('  physical flow: roles, deal, collection, rebuild, rotation ok');
}

// ---- scoring, including the announce-Kapothi variant ----
function fabricateRound(gs, tricksBySeat, kapothiTeam) {
  dealToPlay(gs);
  gs.players.forEach((p, i) => { p.tricks = tricksBySeat[i]; p.hand = []; });
  if (kapothiTeam != null) gs.kapothiTeam = kapothiTeam;
  gs.wonStacks = [];
  const all = game.makeDeck(4);
  for (let i = 0; i < 8; i++) gs.wonStacks.push(all.slice(i * 4, i * 4 + 4));
  gs.tricksPlayed = 8;
  game.endRound(gs);
  return gs;
}
{
  const scoreCase = (tricks, kt) =>
    fabricateRound(game.createGame([{ id: 'x', name: 'H', seat: 0 }], 4), tricks, kt);

  // dealer 0 means the trump caller is seat 1, so the calling team is team 1
  let gs = scoreCase([1, 3, 2, 2]);
  assert(gs.players[1].score === 1 && gs.players[0].score === 0, 'call made: +1');
  gs = scoreCase([3, 1, 2, 2]);
  assert(gs.players[0].score === 2 && gs.players[1].score === 0, 'call broken: defenders +2');
  gs = scoreCase([0, 4, 0, 4]);
  assert(gs.players[1].score === 1, 'unannounced sweep: only +1');
  gs = scoreCase([0, 4, 0, 4], 1);
  assert(gs.players[1].score === 3, 'announced Kapothi: +3');
  gs = scoreCase([4, 0, 4, 0]);
  assert(gs.players[0].score === 2, 'unannounced defender sweep: +2');
  gs = scoreCase([4, 0, 4, 0], 0);
  assert(gs.players[0].score === 3, 'announced defender Kapothi: +3');
  gs = scoreCase([1, 3, 2, 2], 1);
  assert(gs.players[0].score === 4 && gs.players[1].score === 0, 'broken Kapothi: opponents +4');
  gs = scoreCase([2, 2, 2, 2]);
  assert(gs.players.every(p => p.score === 0) && gs.drawBonus === 1, 'drawn hand banks a bonus token');
  console.log('  scoring: +1, +2, announced +3, broken +4, draw ok');
}

// ---- draw carry-over pays out with the next win ----
{
  const gs = game.createGame([{ id: 'x', name: 'H', seat: 0 }], 4);
  fabricateRound(gs, [2, 2, 2, 2]);
  assert(gs.drawBonus === 1, 'first draw banks a token');
  game.nextRound(gs);
  fabricateRound(gs, [2, 2, 2, 2]);
  assert(gs.drawBonus === 2, 'second draw banks another');
  game.nextRound(gs);
  const callerTeam = gs.players[gs.trumpCallerSeat].team;
  const tricks = callerTeam === 1 ? [1, 3, 2, 2] : [3, 1, 2, 2];
  fabricateRound(gs, tricks);
  const callerScore = gs.players.find(p => p.team === callerTeam).score;
  assert(callerScore === 3, 'win after two draws pays 1 + 2 carried (got ' + callerScore + ')');
  assert(gs.drawBonus === 0, 'bonus cleared after payout');
  console.log('  draw carry-over: banks and pays out ok');
}

// ---- kapothi decision fires only on six straight tricks ----
{
  const setup = (t0, t2) => {
    const gs = dealToPlay(game.createGame([{ id: 'x', name: 'H', seat: 0 }], 4));
    gs.players[0].tricks = t0;
    gs.players[2].tricks = t2;
    gs.players[1].tricks = 5 - t0 - t2;
    gs.tricksPlayed = 5;
    gs.players.forEach(p => { p.hand = p.hand.slice(0, 2); });
    gs.trick = [
      { seat: 0, card: { s: '♠', r: 'A', v: 7 } },
      { seat: 1, card: { s: '♥', r: '7', v: 0 } },
      { seat: 2, card: { s: '♥', r: '8', v: 1 } },
      { seat: 3, card: { s: '♥', r: '9', v: 2 } },
    ];
    gs.leadSuit = '♠';
    game.endTrick(gs);
    return gs;
  };

  let gs = setup(3, 2);
  assert(gs.phase === 'kapothi', 'six straight tricks trigger the decision');
  assert(gs.currentSeat === 0, 'the trick-6 winner makes the call');
  game.decideKapothi(gs, true);
  assert(gs.kapothiTeam === 0 && gs.phase === 'play', 'announcing sets the team, play resumes');
  let threw = false;
  try { game.decideKapothi(gs, true); } catch (e) { threw = true; }
  assert(threw, 'decideKapothi outside the phase throws');

  gs = setup(2, 2);
  assert(gs.phase === 'play', 'split tricks: no kapothi phase');
  console.log('  kapothi trigger: 6-0 gate ok');
}

// ---- end-match vote ----
{
  const gs = game.createGame([{ id: 'x', name: 'H', seat: 0 }], 4);
  gs.players.forEach(p => { p.score = p.team === 1 ? 5 : 3; });
  game.endMatchByVote(gs);
  assert(gs.gameOver && gs.gameWinner === 'Team B', 'vote end: leading team wins');
  assert(gs.roundJustEnded && gs.roundDeltas.every(d => d.delta === 0), 'vote end: overlay data, no deltas');

  const tie = game.createGame([{ id: 'x', name: 'H', seat: 0 }], 4);
  tie.players.forEach(p => { p.score = 4; });
  game.endMatchByVote(tie);
  assert(tie.gameOver && tie.gameWinner === null, 'vote end tie: drawn');

  const duel = game.createGame([{ id: 'x', name: 'H', seat: 0 }], 2);
  duel.players[0].score = 2;
  duel.players[1].score = 1;
  game.endMatchByVote(duel);
  assert(duel.gameWinner === duel.players[0].name, '2p vote end: top player wins');
  console.log('  end-match vote: winner, tie, 2p ok');
}

// ---- a full trick locks out extra plays until endTrick ----
{
  const gs = dealToPlay(game.createGame([{ id: 'x', name: 'H', seat: 0 }], 4));
  for (let i = 0; i < 4; i++) game.playCard(gs, gs.currentSeat, game.aiPickCard(gs, gs.currentSeat));
  assert(gs.trickJustEnded, 'trick complete after 4 plays');
  let threw = false;
  try { game.playCard(gs, gs.currentSeat, 0); } catch (e) { threw = true; }
  assert(threw, 'a 5th card into a full trick throws');
  game.endTrick(gs);
  assert(gs.trick.length === 0 && gs.wonStacks.length === 1, 'endTrick collects exactly 4 cards');
  console.log('  full-trick lockout: ok');
}

// ---- illegal play throws ----
{
  const gs = dealToPlay(game.createGame([{ id: 'x', name: 'H', seat: 0 }], 4));
  game.playCard(gs, gs.currentSeat, 0);
  const seat = gs.currentSeat;
  const lead = gs.leadSuit;
  const hand = gs.players[seat].hand;
  const hasLead = hand.some(cd => cd.s === lead);
  const badIdx = hand.findIndex(cd => cd.s !== lead);
  if (hasLead && badIdx !== -1) {
    let threw = false;
    try { game.playCard(gs, seat, badIdx); } catch (e) { threw = true; }
    assert(threw, 'off-suit play throws when the lead suit is held');
    console.log('  illegal-play: throw verified');
  } else {
    console.log('  illegal-play: skipped (no constraint on this deal)');
  }
}

// ---- redeal: a team with fewer than 2 trumps throws the hand in ----
{
  // Deal positions with dealer 0: the caller is seat 1, and each packet of 4
  // goes caller, caller+1, caller+2, caller+3. Team A (seats 0 and 2) sits at
  // positions 4-7, 12-15, 20-23 and 28-31 of the deck.
  const teamAPositions = new Set();
  [4, 12, 20, 28].forEach(start => { for (let i = 0; i < 4; i++) teamAPositions.add(start + i); });

  // Stack a deck so team A ends up with exactly `teamATrumps` spades.
  const stacked = (gs, teamATrumps) => {
    const spades = gs.deck.filter(c => c.s === '♠');
    const others = gs.deck.filter(c => c.s !== '♠');
    const deck = [];
    let aSpades = teamATrumps;
    let bSpades = 8 - teamATrumps;
    for (let pos = 0; pos < 32; pos++) {
      const isA = teamAPositions.has(pos);
      if (isA && aSpades > 0) { deck.push(spades.pop()); aSpades--; }
      else if (!isA && bSpades > 0) { deck.push(spades.pop()); bSpades--; }
      else deck.push(others.pop());
    }
    gs.deck = deck;
    gs.phase = 'dealing1';
    return gs;
  };
  const fresh = () => game.createGame([{ id: 'x', name: 'H', seat: 0 }], 4);

  for (const short of [0, 1]) {
    const gs = stacked(fresh(), short);
    const identity = new Set(gs.deck);
    gs.players.forEach(p => { p.score = p.team === 0 ? 4 : 6; });
    gs.drawBonus = 1;
    game.dealStage1(gs);
    game.chooseTrump(gs, '♠');
    game.dealStage2(gs);
    assert(game.teamTrumpCounts(gs).join() === [short, 8 - short].join(), 'stacked deal gives team A ' + short + ' trump(s)');
    assert(gs.phase === 'redeal', short + ' trump(s) for a team forces a redeal');
    assert(gs.redealInfo && gs.redealInfo.shortTeam === 0 && gs.redealInfo.n === 1, 'redeal info names the short team');
    let threw = false;
    try { game.playCard(gs, gs.trumpCallerSeat, 0); } catch (e) { threw = true; }
    assert(threw, 'no card can be played on a void hand');

    const before = { dealer: gs.dealer, breaker: gs.breakerSeat, caller: gs.trumpCallerSeat, round: gs.roundNum };
    game.redealRound(gs);
    assert(gs.phase === 'shuffle' && gs.currentSeat === before.dealer, 'redeal returns to the same dealer to reshuffle');
    assert(gs.dealer === before.dealer && gs.breakerSeat === before.breaker && gs.trumpCallerSeat === before.caller,
      'the same dealer, breaker and trump caller act again');
    assert(gs.roundNum === before.round, 'a redeal does not advance the round');
    assert(gs.players.every(p => p.score === (p.team === 0 ? 4 : 6)) && gs.drawBonus === 1, 'a redeal scores nothing');
    assert(gs.trump === null && gs.players.every(p => p.hand.length === 0 && p.tricks === 0), 'hands and trump are cleared');
    assert(gs.deck.length === 32 && gs.deck.every(c => identity.has(c)), 'the same 32 physical cards form the new deck');
    assert(gs.redealsThisRound === 1, 'the redeal is counted for the round');
    const logged = gs.history.filter(h => h.type === 'redeal');
    assert(logged.length === 1 && logged[0].shortTeam === 0 && logged[0].counts[0] === short, 'the redeal is logged');
    let again = false;
    try { game.redealRound(gs); } catch (e) { again = true; }
    assert(again, 'redealRound outside the redeal phase throws');

    dealToPlay(gs);
    assert(gs.phase === 'play' && gs.trumpCallerSeat === before.caller, 'after the redeal the hand plays normally');
  }

  // Exactly two trumps is enough to play on.
  const two = stacked(fresh(), 2);
  game.dealStage1(two);
  game.chooseTrump(two, '♠');
  game.dealStage2(two);
  assert(two.phase === 'play', 'two trumps between partners is a playable hand');

  // Over many random deals the redeal fires exactly when a team is short.
  let redeals = 0;
  let mismatches = 0;
  for (let i = 0; i < 1000; i++) {
    const gs = fresh();
    shuf(gs);
    game.applyCut(gs, [[16, 32], [0, 16]]);
    game.dealStage1(gs);
    game.chooseTrump(gs, game.SUITS[i % 4]);
    game.dealStage2(gs);
    const counts = game.teamTrumpCounts(gs);
    const short = Math.min(counts[0], counts[1]) < 2;
    if (short) redeals++;
    if (short !== (gs.phase === 'redeal')) mismatches++;
  }
  assert(mismatches === 0, 'redeal fires if and only if a team holds fewer than 2 trumps');
  assert(redeals > 0 && redeals < 150, 'redeals are uncommon (' + redeals + ' in 1000 deals)');
  console.log('  redeal: forced, logged, same roles, no score, iff short (' + redeals + '/1000 random deals)');
}

// ---- full games to completion, every mode ----
let redeals4p = 0;
for (let run = 1; run <= 3; run++) {
  const gs = game.createGame([{ id: 'x', name: 'Host', seat: 0 }], 4);
  let guard = 0;
  while (!gs.gameOver && guard++ < 5000) {
    if (gs.phase === 'shuffle') shuf(gs);
    else if (gs.phase === 'cut') {
      const k = 5 + Math.floor(Math.random() * 22);
      game.applyCut(gs, [[k, 32], [0, k]]);
    } else if (gs.phase === 'dealing1') game.dealStage1(gs);
    else if (gs.phase === 'trump') game.chooseTrump(gs, game.aiPickTrump(gs, gs.currentSeat));
    else if (gs.phase === 'dealing2') game.dealStage2(gs);
    else if (gs.phase === 'redeal') { redeals4p++; game.redealRound(gs); }
    else if (gs.phase === 'kapothi') game.decideKapothi(gs, game.aiDecideKapothi(gs, gs.currentSeat));
    else if (gs.roundJustEnded) { if (!gs.gameOver) game.nextRound(gs); }
    else {
      game.playCard(gs, gs.currentSeat, game.aiPickCard(gs, gs.currentSeat));
      if (gs.trickJustEnded) game.endTrick(gs);
    }
  }
  assert(gs.gameOver, '4p run ' + run + ' reaches game over');
  assert(gs.players.some(p => p.score >= 10), '4p run ' + run + ': winner reached 10 tokens');
  // The match log tells the whole story: every scored round, in order,
  // ending on the final score.
  const rounds = gs.history.filter(h => h.type === 'round');
  assert(rounds.length === gs.roundNum, '4p run ' + run + ': one log entry per round');
  assert(rounds.every((h, i) => h.round === i + 1), '4p run ' + run + ': log rounds in order');
  const last = rounds[rounds.length - 1];
  const finalScore = [0, 1].map(t => gs.players.find(p => p.team === t).score);
  assert(last && last.scoreAfter.join() === finalScore.join(), '4p run ' + run + ': log ends on the final score');
  assert(rounds.every(h => h.tricksBySeat.reduce((a, b) => a + b, 0) === 8), '4p run ' + run + ': 8 tricks per logged round');
  console.log('  4p run ' + run + ': finished, winner ' + gs.gameWinner);
}

for (const mode of [2, 3]) {
  for (let run = 1; run <= 2; run++) {
    const gs = game.createGame([{ id: 'x', name: 'Host', seat: 0 }], mode);
    let guard = 0;
    while (!gs.gameOver && guard++ < 5000) {
      if (gs.phase === 'trump') game.chooseTrump(gs, game.aiPickTrump(gs, gs.currentSeat));
      else if (gs.roundJustEnded) { if (!gs.gameOver) game.nextRound(gs); }
      else {
        game.playCard(gs, gs.currentSeat, game.aiPickCard(gs, gs.currentSeat));
        if (gs.trickJustEnded) game.endTrick(gs);
      }
    }
    assert(gs.gameOver, mode + 'p run ' + run + ' completes');
    console.log('  ' + mode + 'p run ' + run + ': finished, winner ' + gs.gameWinner);
  }
}

// ---- 2p and 3p auto-deal gives every player all four suits ----
for (const mode of [2, 3]) {
  for (let i = 0; i < 100; i++) {
    const gs = game.createGame([{ id: 'x', name: 'H', seat: 0 }], mode);
    gs.players.forEach(p => {
      game.SUITS.forEach(s => assert(p.hand.some(cd => cd.s === s), mode + 'p: a hand missing a suit'));
    });
  }
}
console.log('  2p/3p auto-deal: every player holds all suits ok');
console.log('  (' + redeals4p + ' redeal(s) occurred during the full 4p games)');

console.log(failures === 0 ? '\nALL TESTS PASSED' : '\n' + failures + ' FAILURES');
process.exit(failures === 0 ? 0 : 1);
