// game.js: pure OMI game logic. No I/O, no sockets, no timers.
// All functions mutate the passed gameState (gs) object.
//
// 4-player mode simulates a persistent physical deck: the same 32 card
// objects circulate between deck, hands, and won tricks forever. The deck
// is never recreated or auto-sorted between rounds. Each round it is
// washed (human-entropy shuffle), cut by the breaker, and dealt 4+4.

const SUITS = ['♠', '♥', '♦', '♣'];
const SNAMES = { '♠': 'Spades', '♥': 'Hearts', '♦': 'Diamonds', '♣': 'Clubs' };
const IS_RED = { '♥': true, '♦': true, '♠': false, '♣': false };
const RANKS = ['7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
const RV = { '7': 0, '8': 1, '9': 2, '10': 3, 'J': 4, 'Q': 5, 'K': 6, 'A': 7 };

// Bots take the first of these not already used by a human at the table.
const AI_NAMES = ['Kamal', 'Nimal', 'Sunil', 'Ruwan', 'Saman', 'Amal', 'Chathura'];

// ---------- Helpers ----------

function makeDeck(mode) {
  const cards = [];
  for (const s of SUITS) {
    for (const r of RANKS) {
      cards.push({ s, r, v: RV[r] });
    }
  }
  if (mode === 3) {
    return cards.filter(c => !((c.s === '♣' && c.r === '7') || (c.s === '♦' && c.r === '7')));
  }
  return cards;
}

function shuffle(array) {
  const a = array.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function sortHand(hand) {
  hand.sort((a, b) => {
    const su = SUITS.indexOf(a.s) - SUITS.indexOf(b.s);
    return su !== 0 ? su : a.v - b.v;
  });
  return hand;
}

// Hash arbitrary entropy numbers (pointer coords/timings from the human
// wash, or server randoms for AI) into a deterministic PRNG.
function seededRandom(nums) {
  let h1 = 0x9e3779b9;
  let h2 = 0x85ebca6b;
  for (let i = 0; i < nums.length; i++) {
    const n = Math.floor(Math.abs(nums[i] * 1024)) >>> 0;
    h1 = Math.imul(h1 ^ n, 2654435761);
    h1 = (h1 << 13) | (h1 >>> 19);
    h2 = Math.imul(h2 ^ (n + i), 1597334677);
    h2 = (h2 << 11) | (h2 >>> 21);
  }
  let a = (h1 ^ h2) >>> 0;
  return function () { // mulberry32
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Auto-deal for 2p/3p modes only. 4p uses the physical deck flow below.
// Table-style fairness: every player is guaranteed at least one card of
// each suit; the remaining cards are dealt uniformly at random.
function dealRound(gs) {
  const deck = makeDeck(gs.mode);
  const handSize = gs.mode === 3 ? 10 : 8;

  const bySuit = {};
  SUITS.forEach(s => { bySuit[s] = shuffle(deck.filter(c => c.s === s)); });

  const hands = gs.players.map(() => []);
  hands.forEach(hand => {
    SUITS.forEach(s => hand.push(bySuit[s].pop()));
  });

  const rest = shuffle(SUITS.reduce((all, s) => all.concat(bySuit[s]), []));
  hands.forEach(hand => {
    while (hand.length < handSize) hand.push(rest.pop());
  });

  gs.players.forEach((p, i) => { p.hand = sortHand(hands[i]); });
  gs.drawPile = gs.mode === 2 ? rest : [];

  if (gs.mode === 2) {
    // Trump = suit of the draw pile's first card; the card stays in the
    // pile and is drawn normally later.
    gs.trump = gs.drawPile[0].s;
    gs.phase = 'play';
    gs.currentSeat = (gs.dealer + 1) % 2;
  } else {
    gs.phase = 'trump';
    gs.trumpChooserSeat = (gs.dealer + 2) % 3; // dealer's right
    gs.currentSeat = gs.trumpChooserSeat;
  }
}

// 4p: open a round on the persistent deck. Roles rotate clockwise with
// the dealer index; the deck sits untouched until the shuffler washes it.
function startRound4(gs) {
  // Deal and play run counter-clockwise: seat+1 is the next player to the
  // dealer's RIGHT (calls trump, gets cards first); seat+3 is the opponent
  // to the dealer's LEFT, who cuts.
  gs.trumpCallerSeat = (gs.dealer + 1) % 4;
  gs.breakerSeat = (gs.dealer + 3) % 4;
  gs.kapothiTeam = -1;
  gs.redealsThisRound = 0;
  gs.redealInfo = null;
  gs.wonStacks = [];
  gs.players.forEach(p => { p.hand = []; });
  gs.phase = 'shuffle';
  gs.currentSeat = gs.dealer;
}

// ---------- Game lifecycle ----------

function createGame(lobbyPlayers, mode, initialDeck) {
  const players = [];
  const taken = new Set(lobbyPlayers.map(p => String(p.name).toLowerCase()));
  const botNames = AI_NAMES.filter(n => !taken.has(n.toLowerCase()));
  let aiIdx = 0;
  for (let seat = 0; seat < mode; seat++) {
    const human = lobbyPlayers.find(p => p.seat === seat);
    players.push({
      name: human ? human.name : botNames[aiIdx++],
      seat,
      team: mode === 4 ? seat % 2 : seat,
      isAI: !human,
      hand: [],
      tricks: 0,
      score: 0,
    });
  }

  const gs = {
    mode,
    players,
    phase: 'shuffle',
    trump: null,
    leadSuit: null,
    trick: [],
    currentSeat: 0,
    dealer: 0,
    trumpChooserSeat: 0,
    trumpCallerSeat: -1,
    breakerSeat: -1,
    deck: [],
    wonStacks: [],
    drawBonus: 0,    // tokens carried over from 4-4 drawn hands
    kapothiTeam: -1, // team that announced Kapothi this round
    drawPile: [],
    tricksTot: mode === 2 ? 16 : mode === 3 ? 10 : 8,
    tricksPlayed: 0,
    roundNum: 1,
    scoreTarget: mode === 4 ? 10 : 25,
    roundsWon: mode === 2 ? [0, 0] : null,
    trickJustEnded: false,
    roundJustEnded: false,
    roundDeltas: null,
    roundNote: '',
    gameOver: false,
    gameWinner: null,
    readyCount: 0,
    lastEvent: '',
    redealsThisRound: 0, // 4p: hands thrown in this round for a trump shortage
    redealInfo: null,    // { counts, shortTeam, n } while a redeal is pending
    history: [],         // 4p: one entry per scored round or redeal, for match records
  };

  if (mode === 4) {
    // Carry over the deck from a previous game when provided (a table's
    // pack is never reset); otherwise open a fresh factory-ordered pack.
    gs.deck = (Array.isArray(initialDeck) && initialDeck.length === 32)
      ? initialDeck.slice()
      : makeDeck(4);
    startRound4(gs);
  } else {
    dealRound(gs);
  }
  return gs;
}

// ---------- 4p physical deck phases ----------
//
// Shuffling models real mixing instead of perfect randomisation, so
// structure from last round's collected tricks genuinely survives a lazy
// shuffle (Bayer-Diaconis: even 5 riffles of 52 cards is far from uniform).
// deck[0] is the TOP of the physical stack throughout.

// The smoosh only partially mixes: short washes leave plenty of structure.
// One localised swap per ~80ms of active washing.
function washDeck(deck, rand, washMs) {
  const ops = Math.min(150, Math.floor(washMs / 80));
  for (let k = 0; k < ops; k++) {
    const i = Math.floor(rand() * deck.length);
    let j = i + (1 + Math.floor(rand() * 4)) * (rand() < 0.5 ? -1 : 1);
    j = Math.max(0, Math.min(deck.length - 1, j));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
}

// One Gilbert-Shannon-Reeds riffle: cut at Binomial(n, 1/2), then drop from
// each heap with probability proportional to its remaining size.
function riffleOnce(deck, rand) {
  let cut = 0;
  for (let i = 0; i < deck.length; i++) if (rand() < 0.5) cut++;
  const left = deck.slice(0, cut);
  const right = deck.slice(cut);
  const out = [];
  let li = 0;
  let ri = 0;
  while (li < left.length || ri < right.length) {
    const lRem = left.length - li;
    const rRem = right.length - ri;
    out.push(rand() * (lRem + rRem) < lRem ? left[li++] : right[ri++]);
  }
  return out;
}

// One overhand pass: packets peeled off the top drop onto the new pile,
// so packet order reverses while cards inside each packet keep theirs.
function overhandOnce(deck, packets) {
  let out = [];
  let pos = 0;
  for (const size of packets) {
    out = deck.slice(pos, pos + size).concat(out);
    pos += size;
  }
  return out;
}

// payload = { entropy: number[], washMs, ops: [{t:'r'} | {t:'o', packets}] }
// entropy (pointer coords/timings, or server randoms for AI) seeds every
// random choice, so the same payload always produces the same deck.
function applyShuffle(gs, payload) {
  if (gs.mode !== 4 || gs.phase !== 'shuffle') throw new Error('Not in shuffle phase');
  const entropy = payload && payload.entropy;
  const washMs = Math.max(0, Number(payload && payload.washMs) || 0);
  const ops = payload && payload.ops;
  if (!Array.isArray(entropy) || entropy.length < 8) throw new Error('Missing entropy');
  if (!Array.isArray(ops) || ops.length < 1 || ops.length > 24) throw new Error('Bad shuffle ops');

  const rand = seededRandom(entropy);
  washDeck(gs.deck, rand, washMs);
  for (const op of ops) {
    if (op && op.t === 'r') {
      gs.deck = riffleOnce(gs.deck, rand);
    } else if (op && op.t === 'o') {
      const packets = Array.isArray(op.packets) ? op.packets.map(p => Math.trunc(p)) : [];
      if (packets.length < 1 || packets.some(p => !(p >= 1))) throw new Error('Bad overhand packets');
      if (packets.reduce((a, b) => a + b, 0) !== gs.deck.length) throw new Error('Bad overhand packets');
      gs.deck = overhandOnce(gs.deck, packets);
    } else {
      throw new Error('Unknown shuffle op');
    }
  }

  gs.phase = 'cut';
  gs.currentSeat = gs.breakerSeat;
  gs.lastEvent = `${gs.players[gs.dealer].name} shuffled the deck`;
}

// segments: up to 3 [start, end) slices of the current deck in their new
// top-first stacking order. A classic single cut at k is [[k,32],[0,k]].
function applyCut(gs, segments) {
  if (gs.mode !== 4 || gs.phase !== 'cut') throw new Error('Not in cut phase');
  const N = gs.deck.length;
  if (!Array.isArray(segments) || segments.length < 2 || segments.length > 3) {
    throw new Error('Cut must produce 2 or 3 piles');
  }
  const clean = segments.map(seg => [Math.trunc(seg[0]), Math.trunc(seg[1])]);
  clean.forEach(([s, e]) => {
    if (!Number.isFinite(s) || !Number.isFinite(e) || s < 0 || e > N || s >= e) {
      throw new Error('Bad cut segment');
    }
  });
  let pos = 0;
  clean.slice().sort((a, b) => a[0] - b[0]).forEach(([s, e]) => {
    if (s !== pos) throw new Error('Cut segments must cover the whole deck');
    pos = e;
  });
  if (pos !== N) throw new Error('Cut segments must cover the whole deck');

  const old = gs.deck;
  gs.deck = clean.reduce((d, [s, e]) => d.concat(old.slice(s, e)), []);
  gs.phase = 'dealing1';
  gs.currentSeat = gs.dealer;
  gs.lastEvent = `${gs.players[gs.breakerSeat].name} cut the deck`;
}

// First packet: 4 cards each off the top, clockwise from the trump caller.
function dealStage1(gs) {
  for (let k = 0; k < 4; k++) {
    const seat = (gs.trumpCallerSeat + k) % 4;
    for (let c = 0; c < 4; c++) gs.players[seat].hand.push(gs.deck.shift());
    sortHand(gs.players[seat].hand);
  }
  gs.phase = 'trump';
  gs.currentSeat = gs.trumpCallerSeat;
}

// Trumps held by each team, [team A, team B].
function teamTrumpCounts(gs) {
  const counts = [0, 0];
  gs.players.forEach(p => {
    counts[p.team] += p.hand.filter(c => c.s === gs.trump).length;
  });
  return counts;
}

// Keep the match log bounded however long a game runs.
function logHistory(gs, entry) {
  gs.history.push(entry);
  if (gs.history.length > 200) gs.history.shift();
}

// Second packet after the trump lock: hands finalise at 8, caller leads.
// If either team holds fewer than 2 trumps between its two players the hand
// cannot be played: it is thrown in and redealt (see redealRound).
function dealStage2(gs) {
  for (let k = 0; k < 4; k++) {
    const seat = (gs.trumpCallerSeat + k) % 4;
    for (let c = 0; c < 4; c++) gs.players[seat].hand.push(gs.deck.shift());
    sortHand(gs.players[seat].hand);
  }
  gs.leadSuit = null;

  const counts = teamTrumpCounts(gs);
  const shortTeam = counts[0] < 2 ? 0 : counts[1] < 2 ? 1 : -1;
  if (shortTeam !== -1) {
    gs.redealsThisRound++;
    gs.redealInfo = { counts, shortTeam, n: gs.redealsThisRound };
    logHistory(gs, {
      type: 'redeal',
      round: gs.roundNum,
      dealer: gs.dealer,
      callerSeat: gs.trumpCallerSeat,
      trump: gs.trump,
      counts: counts.slice(),
      shortTeam,
    });
    const n = counts[shortTeam];
    gs.phase = 'redeal'; // server calls redealRound() after a beat
    gs.currentSeat = gs.dealer;
    gs.lastEvent = `Redeal! Team ${'AB'[shortTeam]} holds only ${n} trump${n === 1 ? '' : 's'}`;
    return;
  }

  gs.phase = 'play';
  gs.currentSeat = gs.trumpCallerSeat;
}

// Throw the hand in after a trump shortage. The dealer gathers the hands in
// deal order (trump caller first), each dropped on top of the pile, and the
// same 32 cards become the deck again. The round does not advance: the same
// dealer reshuffles, the same breaker cuts and the same caller names trump.
function redealRound(gs) {
  if (gs.mode !== 4 || gs.phase !== 'redeal') throw new Error('No redeal pending');
  const bottomUp = [];
  for (let k = 0; k < 4; k++) {
    const p = gs.players[(gs.trumpCallerSeat + k) % 4];
    p.hand.forEach(c => bottomUp.push(c));
    p.hand = [];
  }
  gs.deck = bottomUp.reverse().concat(gs.deck); // deck[0] is the top

  gs.players.forEach(p => { p.tricks = 0; });
  gs.trump = null;
  gs.leadSuit = null;
  gs.trick = [];
  gs.tricksPlayed = 0;
  gs.trickJustEnded = false;
  gs.kapothiTeam = -1;
  gs.wonStacks = [];
  gs.redealInfo = null;
  gs.phase = 'shuffle';
  gs.currentSeat = gs.dealer;
  gs.lastEvent = `${gs.players[gs.dealer].name} gathers the cards to reshuffle`;
}

function chooseTrump(gs, suit) {
  gs.trump = suit;
  gs.lastEvent = `Trump: ${suit} ${SNAMES[suit]}!`;
  if (gs.mode === 4) {
    gs.phase = 'dealing2'; // server deals the second packet after a beat
    gs.currentSeat = gs.trumpCallerSeat;
  } else {
    gs.phase = 'play';
    gs.currentSeat = gs.trumpChooserSeat; // trump chooser leads
    gs.leadSuit = null;
  }
}

// ---------- Play ----------

function legalCards(gs, seat) {
  const hand = gs.players[seat].hand;
  if (gs.leadSuit === null) return hand;
  const suitCards = hand.filter(c => c.s === gs.leadSuit);
  return suitCards.length > 0 ? suitCards : hand;
}

function playCard(gs, seat, cardIndex) {
  if (gs.phase !== 'play') throw new Error('Not in play phase');
  if (gs.trickJustEnded || gs.trick.length >= gs.mode) {
    throw new Error('Trick already complete'); // waiting for endTrick()
  }
  const card = gs.players[seat].hand[cardIndex];
  if (!card || !legalCards(gs, seat).includes(card)) {
    throw new Error('Illegal card play');
  }

  gs.players[seat].hand.splice(cardIndex, 1);
  if (gs.leadSuit === null) gs.leadSuit = card.s;
  gs.trick.push({ seat, card });
  gs.trickJustEnded = false;

  if (gs.trick.length === gs.mode) {
    gs.trickJustEnded = true; // server calls endTrick() after a delay
  } else {
    gs.currentSeat = (seat + 1) % gs.mode;
  }
}

function beats(challenger, current, trump, lead) {
  if (challenger.s === trump && current.s !== trump) return true;
  if (challenger.s !== trump && current.s === trump) return false;
  if (challenger.s === current.s) return challenger.v > current.v;
  if (current.s === lead && challenger.s !== lead) return false;
  if (challenger.s === lead && current.s !== lead) return true;
  return false;
}

function getTrickWinner(trick, trump, lead) {
  if (trick.length === 0) return null;
  let best = trick[0];
  for (let i = 1; i < trick.length; i++) {
    if (beats(trick[i].card, best.card, trump, lead)) best = trick[i];
  }
  return best;
}

function endTrick(gs) {
  const winner = getTrickWinner(gs.trick, gs.trump, gs.leadSuit);
  if (!winner) return;

  gs.players[winner.seat].tricks++;
  gs.tricksPlayed++;
  gs.lastEvent = `${gs.players[winner.seat].name} wins with ${winner.card.r}${winner.card.s}`;

  if (gs.mode === 4) {
    // Winner gathers the trick face-down in the order it was thrown:
    // first card played at the bottom of the sub-stack, last on top.
    gs.wonStacks.push(gs.trick.map(t => t.card));
  }

  if (gs.mode === 2 && gs.drawPile.length > 0) {
    // Trick winner draws first, then the loser
    gs.players[winner.seat].hand.push(gs.drawPile.shift());
    sortHand(gs.players[winner.seat].hand);
    const loser = (winner.seat + 1) % 2;
    if (gs.drawPile.length > 0) {
      gs.players[loser].hand.push(gs.drawPile.shift());
      sortHand(gs.players[loser].hand);
    }
  }

  gs.trick = [];
  gs.leadSuit = null;
  gs.trickJustEnded = false;
  gs.currentSeat = winner.seat;

  const anyCards = gs.players.some(p => p.hand.length > 0);
  if (!anyCards || gs.tricksPlayed >= gs.tricksTot) {
    endRound(gs);
    return;
  }

  // Announce-Kapothi variant: a team holding all 6 tricks so far must
  // declare before the 7th trick to claim the sweep bonus. The trick-6
  // winner (who leads next) makes the call for their team.
  if (gs.mode === 4 && gs.tricksPlayed === 6) {
    const winnerTeam = gs.players[winner.seat].team;
    const teamTricks = gs.players
      .filter(p => p.team === winnerTeam)
      .reduce((s, p) => s + p.tricks, 0);
    if (teamTricks === 6) {
      gs.phase = 'kapothi';
    }
  }
}

function decideKapothi(gs, announce) {
  if (gs.phase !== 'kapothi') throw new Error('No Kapothi decision pending');
  const seat = gs.currentSeat;
  if (announce) {
    gs.kapothiTeam = gs.players[seat].team;
    gs.lastEvent = `${gs.players[seat].name} announces KAPOTHI!`;
  }
  gs.phase = 'play';
}

// Announce when the last two cards look unbeatable: the boss trump plus
// another trump, or the boss trump with no enemy trumps left to fear.
function aiDecideKapothi(gs, seat) {
  const trump = gs.trump;
  const hand = gs.players[seat].hand;
  const seen = hand.slice();
  gs.wonStacks.forEach(st => st.forEach(c => seen.push(c)));

  // Cards of a suit that could still be in other hands
  const outstanding = suit =>
    RANKS.map((r, v) => v).filter(v => !seen.some(c => c.s === suit && c.v === v));

  const bossOf = card => outstanding(card.s).every(v => v < card.v);

  const trumps = hand.filter(c => c.s === trump);
  if (trumps.length === 2 && trumps.some(bossOf)) return true;
  if (trumps.length === 1 && bossOf(trumps[0]) && outstanding(trump).length === 0) {
    const side = hand.find(c => c.s !== trump);
    return side ? bossOf(side) : true;
  }
  return false;
}

// ---------- Round scoring ----------

function endRound(gs) {
  const deltas = gs.players.map(() => 0);
  let note = '';
  let roundLog = null; // 4p match record entry

  if (gs.mode === 4) {
    const callerTeam = gs.players[gs.trumpCallerSeat].team;
    const teamName = t => (t === 0 ? 'Team A' : 'Team B');
    const callerName = teamName(callerTeam);
    const defenderName = teamName(1 - callerTeam);
    const ct = gs.players.filter(p => p.team === callerTeam).reduce((s, p) => s + p.tricks, 0);
    const dt = gs.tricksTot - ct;
    const sweepTeam = ct === 8 ? callerTeam : dt === 8 ? 1 - callerTeam : -1;

    let points = 0;
    let scoringTeam = -1;
    let outcome;
    let bonusPaid = 0;
    if (sweepTeam !== -1 && gs.kapothiTeam === sweepTeam) {
      points = 3; scoringTeam = sweepTeam; outcome = 'kapothi-made';
      note = `KAPOTHI! ${teamName(sweepTeam)} announced and swept all 8 for +3`;
    } else if (gs.kapothiTeam !== -1) {
      // Announced but dropped one of the last two tricks
      points = 4; scoringTeam = 1 - gs.kapothiTeam; outcome = 'kapothi-broken';
      note = `Kapothi broken! ${teamName(scoringTeam)} snatch a trick for +4`;
    } else if (ct >= 5) {
      points = 1; scoringTeam = callerTeam; outcome = 'call-made';
      note = ct === 8
        ? `${callerName} swept all 8 unannounced, only +1`
        : `${callerName} made their call with ${ct} tricks, +1`;
    } else if (ct === 4) {
      gs.drawBonus++;
      outcome = 'draw';
      note = gs.drawBonus > 1
        ? `Drawn again. ${gs.drawBonus} bonus tokens now wait for the next winners`
        : 'Drawn 4 each. A bonus token waits for the next winners';
    } else {
      points = 2; scoringTeam = 1 - callerTeam; outcome = 'call-broken';
      note = dt === 8
        ? `${defenderName} swept all 8 unannounced, +2`
        : `${defenderName} broke the call with ${dt} tricks, +2`;
    }

    if (scoringTeam !== -1 && gs.drawBonus > 0) {
      note += ` (+${gs.drawBonus} carried token${gs.drawBonus > 1 ? 's' : ''})`;
      points += gs.drawBonus;
      bonusPaid = gs.drawBonus;
      gs.drawBonus = 0;
    }
    gs.players.forEach((p, i) => {
      deltas[i] = p.team === scoringTeam ? points : 0;
    });
    roundLog = {
      type: 'round',
      round: gs.roundNum,
      dealer: gs.dealer,
      callerSeat: gs.trumpCallerSeat,
      trump: gs.trump,
      tricksBySeat: gs.players.map(p => p.tricks),
      outcome,
      scoringTeam,
      points,
      kapothiTeam: gs.kapothiTeam,
      bonusPaid,
      note,
    };

    // The winner of each trick stacked it face-down; now the sub-stacks
    // pile up in the order they were won and become next round's deck.
    // deck[0] = top, so the flattened bottom-up pile is reversed.
    const bottomUp = [];
    gs.wonStacks.forEach(st => st.forEach(c => bottomUp.push(c)));
    if (bottomUp.length === 32) gs.deck = bottomUp.reverse();
    gs.wonStacks = [];
  } else if (gs.mode === 3) {
    gs.players.forEach((p, i) => { deltas[i] = p.tricks; });
    const max = Math.max(...gs.players.map(p => p.tricks));
    const winners = gs.players.filter(p => p.tricks === max);
    note = `${winners.map(p => p.name).join(' & ')} won with ${max} tricks!`;
  } else {
    const p0 = gs.players[0].tricks;
    const p1 = gs.players[1].tricks;
    if (p0 > p1) {
      deltas[0] = 1;
      gs.roundsWon[0]++;
      note = `${gs.players[0].name} wins (${p0} vs ${p1} tricks)`;
    } else if (p1 > p0) {
      deltas[1] = 1;
      gs.roundsWon[1]++;
      note = `${gs.players[1].name} wins (${p1} vs ${p0} tricks)`;
    } else {
      note = `Tied! (${p0} tricks each)`;
    }
  }

  gs.players.forEach((p, i) => { p.score += deltas[i]; });
  if (roundLog) {
    roundLog.scoreAfter = [0, 1].map(t => gs.players.find(p => p.team === t).score);
    logHistory(gs, roundLog);
  }

  gs.roundDeltas = gs.players.map((p, i) => ({
    seat: i,
    name: p.name,
    tricks: p.tricks,
    delta: deltas[i],
    total: p.score,
    team: p.team,
  }));
  gs.roundNote = note;
  gs.roundJustEnded = true;
  gs.readyCount = 0;

  // Game over checks
  if (gs.mode === 4) {
    if (gs.players.some(p => p.score >= gs.scoreTarget)) {
      gs.gameOver = true;
      const top = gs.players.reduce((a, b) => (b.score > a.score ? b : a));
      gs.gameWinner = top.team === 0 ? 'Team A' : 'Team B';
    }
  } else if (gs.mode === 3) {
    if (gs.players.some(p => p.score >= gs.scoreTarget)) {
      gs.gameOver = true;
      const top = gs.players.reduce((a, b) => (b.score > a.score ? b : a));
      gs.gameWinner = top.name;
    }
  } else {
    if (gs.roundsWon[0] >= 3) {
      gs.gameOver = true;
      gs.gameWinner = gs.players[0].name;
    } else if (gs.roundsWon[1] >= 3) {
      gs.gameOver = true;
      gs.gameWinner = gs.players[1].name;
    }
  }
}

// All players agreed to stop: whoever leads on score takes the match.
function endMatchByVote(gs) {
  let winner = null;
  if (gs.mode === 4) {
    const a = gs.players.find(p => p.team === 0).score;
    const b = gs.players.find(p => p.team === 1).score;
    winner = a > b ? 'Team A' : b > a ? 'Team B' : null;
  } else {
    const top = Math.max(...gs.players.map(p => p.score));
    const leaders = gs.players.filter(p => p.score === top);
    winner = leaders.length === 1 ? leaders[0].name : null;
  }

  gs.gameOver = true;
  gs.gameWinner = winner;
  gs.endedByVote = true;
  gs.roundNote = winner
    ? 'Match ended by agreement. Highest score wins'
    : 'Match ended by agreement. Scores level, so it is a draw';
  gs.roundDeltas = gs.players.map((p, i) => ({
    seat: i,
    name: p.name,
    tricks: p.tricks,
    delta: 0,
    total: p.score,
    team: p.team,
  }));
  gs.roundJustEnded = true;
  gs.readyCount = 0;
  gs.trickJustEnded = false;
}

function nextRound(gs) {
  gs.roundNum++;
  gs.dealer = (gs.dealer + 1) % gs.mode;

  gs.players.forEach(p => { p.tricks = 0; });

  gs.trump = null;
  gs.leadSuit = null;
  gs.trick = [];
  gs.tricksPlayed = 0;
  gs.roundJustEnded = false;
  gs.roundDeltas = null;
  gs.roundNote = '';
  gs.gameOver = false;
  gs.gameWinner = null;
  gs.readyCount = 0;
  gs.trickJustEnded = false;
  gs.lastEvent = '';

  if (gs.mode === 4) {
    startRound4(gs); // deck persists exactly as the last round left it
  } else {
    dealRound(gs);
  }
}

// ---------- AI ----------

function aiPickTrump(gs, seat) {
  const hand = gs.players[seat].hand;
  let bestSuit = SUITS[0];
  let bestScore = -1;
  for (const s of SUITS) {
    const score = hand.filter(c => c.s === s).reduce((sum, c) => sum + c.v + 1, 0);
    if (score > bestScore) {
      bestScore = score;
      bestSuit = s;
    }
  }
  return bestSuit;
}

function aiLead(cards, trump) {
  const aces = cards.filter(c => c.r === 'A');
  if (aces.length > 0) return aces[0];

  const nonTrump = cards.filter(c => c.s !== trump);
  const pool = nonTrump.length > 0 ? nonTrump : cards;
  return pool.slice().sort((a, b) => b.v - a.v)[0];
}

function aiFollow(gs, seat, playable) {
  const trump = gs.trump;
  const lead = gs.leadSuit;
  const currentBest = getTrickWinner(gs.trick, trump, lead);
  const byLow = arr => arr.slice().sort((a, b) => a.v - b.v)[0];

  const partnerWinning = gs.mode === 4
    && currentBest
    && gs.players[currentBest.seat].team === gs.players[seat].team;
  if (partnerWinning) return byLow(playable);

  const winners = playable.filter(c => beats(c, currentBest.card, trump, lead));
  if (winners.length > 0) return byLow(winners); // cheapest win

  // Void in lead suit → try lowest over-trump
  const handSuit = gs.players[seat].hand.filter(c => c.s === lead);
  if (handSuit.length === 0) {
    const trumpCards = playable.filter(c => c.s === trump);
    if (trumpCards.length > 0) {
      const overTrump = trumpCards.filter(c => beats(c, currentBest.card, trump, lead));
      if (overTrump.length > 0) return byLow(overTrump);
    }
  }

  return byLow(playable); // give up, throw lowest
}

function aiPickCard(gs, seat) {
  const playable = legalCards(gs, seat);
  const card = gs.leadSuit === null
    ? aiLead(playable, gs.trump)
    : aiFollow(gs, seat, playable);
  return gs.players[seat].hand.indexOf(card);
}

module.exports = {
  SUITS,
  SNAMES,
  IS_RED,
  RANKS,
  RV,
  makeDeck,
  createGame,
  applyShuffle,
  riffleOnce,
  overhandOnce,
  applyCut,
  endMatchByVote,
  dealStage1,
  dealStage2,
  teamTrumpCounts,
  redealRound,
  chooseTrump,
  decideKapothi,
  aiDecideKapothi,
  playCard,
  endTrick,
  endRound,
  nextRound,
  legalCards,
  getTrickWinner,
  beats,
  aiPickTrump,
  aiPickCard,
};
