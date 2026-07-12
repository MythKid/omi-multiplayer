// Game orchestration: lobby state, the round flow, AI scheduling, and every
// socket event handler. The pure rules live in game.js; this module wires
// those rules to connected players and records finished games. One match runs
// at a time, so the state lives at module scope.
const crypto = require('crypto');
const game = require('../game');
const config = require('../config');
const logger = require('../utils/logger');
const network = require('../utils/network');
const { sanitizeName } = require('../utils/sanitize');
const leaderboard = require('./leaderboardService');

// How long a seat is held for a dropped player to return (refresh, brief
// network blip) before the game is ended for everyone.
const RECONNECT_GRACE_MS = 90 * 1000;

let io = null;
let joinQR = null;

function init(ioInstance) { io = ioInstance; }
function setJoinQR(dataUrl) { joinQR = dataUrl; }

// ---------- State ----------

const lobby = {
  players: [], // { id, name, seat, ready }
  mode: 4,
  hostId: null,
  teamPairing: 0,
};

// The three possible 2v2 pairings of the four lobby slots. Partners sit across
// from each other, so at game start slots are remapped to seats with each pair
// on opposite sides. Index 0 keeps the join order.
const TEAM_PAIRINGS = [
  [[0, 2], [1, 3]],
  [[0, 1], [2, 3]],
  [[0, 3], [1, 2]],
];

let gameState = null;   // null = in lobby
let aiTimeout = null;
let trickTimeout = null;
let shuffleFirstMoveAt = null; // wall-clock start of the current human wash
let lastDeck = null;           // the physical pack survives between games (4p)
let endVote = null;            // { agreed: Set<seat> } while an end-match vote is live
let resultRecorded = false;    // guard so a finished game is recorded only once

// ---------- Helpers ----------

function playerBySocket(socket) {
  return lobby.players.find(p => p.id === socket.id);
}

function broadcastLobbyUpdate() {
  const payload = {
    players: lobby.players.map(p => ({ name: p.name, seat: p.seat })),
    mode: lobby.mode,
    hostSeat: 0,
    serverIP: network.getLocalIP(),
    serverPort: config.port,
    joinURL: network.getJoinURL(),
    joinHost: network.getJoinHost(),
    joinQR,
    teamPairing: lobby.teamPairing,
  };
  lobby.players.forEach(p => {
    const socket = io.sockets.sockets.get(p.id);
    if (!socket) return;
    socket.emit('lobby-update', { ...payload, isHost: p.id === lobby.hostId, yourSeat: p.seat });
  });
}

function buildClientState(gs, forSeat) {
  return {
    phase: gs.phase,
    trump: gs.trump,
    leadSuit: gs.leadSuit,
    currentSeat: gs.currentSeat,
    trick: gs.trick,
    tricksPlayed: gs.tricksPlayed,
    tricksTot: gs.tricksTot,
    roundNum: gs.roundNum,
    mode: gs.mode,
    dealer: gs.dealer,
    trumpCallerSeat: gs.trumpCallerSeat,
    breakerSeat: gs.breakerSeat,
    deckCount: gs.deck ? gs.deck.length : 0,
    drawBonus: gs.drawBonus || 0,
    kapothiTeam: gs.kapothiTeam != null ? gs.kapothiTeam : -1,
    endVote: endVote ? { agreedSeats: Array.from(endVote.agreed) } : null,
    roundJustEnded: gs.roundJustEnded || false,
    roundDeltas: gs.roundDeltas || null,
    roundNote: gs.roundNote || '',
    gameOver: gs.gameOver || false,
    gameWinner: gs.gameWinner || null,
    drawPileCount: gs.drawPile.length,
    lastEvent: gs.lastEvent || '',
    players: gs.players.map((p, i) => ({
      name: p.name,
      seat: p.seat,
      team: p.team,
      tricks: p.tricks,
      score: p.score,
      ai: p.isAI,
      cardCount: p.hand.length, // others see count only
      isYou: i === forSeat,
    })),
    myHand: gs.players[forSeat] ? gs.players[forSeat].hand : [],
    mySeat: forSeat,
    readyCount: gs.readyCount || 0,
    totalPlayers: gs.players.length,
    // Seats whose human is currently disconnected but still within the
    // reconnect grace window, so clients can show a "waiting" banner.
    disconnectedSeats: lobby.players
      .filter(p => p.connected === false && p.seat < gs.mode)
      .map(p => ({ seat: p.seat, name: p.name })),
  };
}

// When a 4-player game ends with a two-human winning team, record the team's
// final score on the leaderboard. Runs at most once per game.
function recordResultIfFinished() {
  if (!gameState || !gameState.gameOver || resultRecorded) return;
  resultRecorded = true;
  if (gameState.mode !== 4) return;

  const winner = gameState.gameWinner;
  if (winner !== 'Team A' && winner !== 'Team B') return; // draw or no winner
  const seats = winner === 'Team A' ? [0, 2] : [1, 3];

  const humanBySeat = {};
  lobby.players.forEach(p => { if (p.seat < gameState.mode) humanBySeat[p.seat] = p; });
  const a = humanBySeat[seats[0]];
  const b = humanBySeat[seats[1]];
  if (!a || !b) return; // a bot was on the winning team, skip

  leaderboard.submitTeamResult(a.name, b.name, gameState.players[seats[0]].score);
}

function broadcastGameState() {
  if (!gameState) return;
  recordResultIfFinished();

  lobby.players.forEach(player => {
    const socket = io.sockets.sockets.get(player.id);
    if (!socket) return;
    socket.emit('state-update', buildClientState(gameState, player.seat));
  });

  gameState.lastEvent = ''; // toast events are one-shot
  if (gameState.phase !== 'shuffle') shuffleFirstMoveAt = null;
}

// Humans actually seated in the running game
function humanGameSeats() {
  if (!gameState) return [];
  return lobby.players.filter(p => p.seat < gameState.mode).map(p => p.seat);
}

function finishTrickAfterDelay() {
  clearTimeout(trickTimeout);
  trickTimeout = setTimeout(() => {
    if (!gameState || gameState.gameOver || gameState.roundJustEnded) return;
    game.endTrick(gameState);
    broadcastGameState();
    if (!gameState.roundJustEnded) scheduleFlow();
  }, 2300); // window for the trick-gather animation
}

// Per-phase delays: dealing phases run on a timer for everyone (clients
// animate the cards flying); the rest only fire when the actor is an AI.
// play/trump get random jitter on top so the AIs feel like they think.
const PHASE_DELAYS = {
  shuffle: 8000, // canned wash + overhand pass + two riffles
  cut: 2400,
  dealing1: 4600, // four 4-card packets in flight
  dealing2: 4600,
  trump: 2600,
  kapothi: 2200,
  play: 1400,
};
const JITTER_PHASES = { play: 800, trump: 800 };

function scheduleFlow() {
  if (!gameState) return;
  if (gameState.trickJustEnded || gameState.roundJustEnded) return;
  const phase = gameState.phase;
  const isDealing = phase === 'dealing1' || phase === 'dealing2';
  if (!isDealing && humanGameSeats().includes(gameState.currentSeat)) return; // human acts

  clearTimeout(aiTimeout);
  aiTimeout = setTimeout(() => {
    if (!gameState || gameState.phase !== phase) return;
    const currentSeat = gameState.currentSeat;

    if (phase === 'shuffle') {
      const entropy = Array.from({ length: 64 }, () => Math.random() * 1e6);
      // AI mixes like a person would: an overhand pass then two riffles
      const packets = [];
      let rem = gameState.deck.length;
      while (rem > 0) {
        const s = Math.min(rem, 2 + Math.floor(Math.random() * 5));
        packets.push(s);
        rem -= s;
      }
      game.applyShuffle(gameState, {
        entropy,
        washMs: 3000,
        ops: [{ t: 'o', packets }, { t: 'r' }, { t: 'r' }],
      });
    } else if (phase === 'cut') {
      const k = 8 + Math.floor(Math.random() * 17); // cut somewhere mid-deck
      game.applyCut(gameState, [[k, 32], [0, k]]);
    } else if (phase === 'dealing1') {
      game.dealStage1(gameState);
    } else if (phase === 'dealing2') {
      game.dealStage2(gameState);
    } else if (phase === 'trump') {
      game.chooseTrump(gameState, game.aiPickTrump(gameState, currentSeat));
    } else if (phase === 'kapothi') {
      game.decideKapothi(gameState, game.aiDecideKapothi(gameState, currentSeat));
    } else if (phase === 'play') {
      game.playCard(gameState, currentSeat, game.aiPickCard(gameState, currentSeat));
      broadcastGameState();
      if (gameState.trickJustEnded) {
        finishTrickAfterDelay();
      } else {
        scheduleFlow();
      }
      return;
    }

    broadcastGameState();
    scheduleFlow();
  }, (PHASE_DELAYS[phase] || 1400) + Math.random() * (JITTER_PHASES[phase] || 0));
}

// ---------- Handlers ----------

function handleJoin(socket, name) {
  if (gameState !== null) {
    socket.emit('server-error', { message: 'A game is already in progress. Try again later.' });
    return;
  }
  if (lobby.players.length >= 4) {
    socket.emit('server-error', { message: 'Lobby is full (max 4 players).' });
    return;
  }
  if (playerBySocket(socket)) return; // already joined, ignore duplicates

  const seat = lobby.players.length;
  if (seat === 0) lobby.hostId = socket.id;

  // All scripts welcome; only control, zero-width and bidi characters go.
  const cleanName = sanitizeName(name, 14) || `Player ${seat + 1}`;
  // A per-player token lets a refreshed or briefly-dropped client reclaim its
  // seat (see handleConnection / resumePlayer).
  const token = crypto.randomUUID();
  lobby.players.push({ id: socket.id, name: cleanName, seat, ready: false, connected: true, token, graceTimer: null });
  socket.emit('session', { token });
  logger.debug(`${cleanName} joined (seat ${seat})`);
  broadcastLobbyUpdate();
}

function handleSetMode(socket, mode) {
  if (socket.id !== lobby.hostId) return;
  if (gameState !== null) return;
  if (![2, 3, 4].includes(mode)) return;
  lobby.mode = mode;
  broadcastLobbyUpdate();
}

function handleSetTeams(socket, pairing) {
  if (socket.id !== lobby.hostId) return;
  if (gameState !== null) return;
  if (lobby.mode !== 4) return;
  if (![0, 1, 2].includes(pairing)) return;
  lobby.teamPairing = pairing;
  broadcastLobbyUpdate();
}

function handleHostStart(socket) {
  if (socket.id !== lobby.hostId) return;
  if (gameState !== null) return;
  if (lobby.players.length < 1) return;

  // 4p: remap lobby slots to game seats so the chosen partners sit across
  // from each other (teams are seat 0+2 vs seat 1+3).
  if (lobby.mode === 4) {
    const pairs = TEAM_PAIRINGS[lobby.teamPairing] || TEAM_PAIRINGS[0];
    const order = [pairs[0][0], pairs[1][0], pairs[0][1], pairs[1][1]];
    const bySlot = {};
    lobby.players.forEach(p => { bySlot[p.seat] = p; });
    order.forEach((slot, seat) => {
      if (bySlot[slot]) bySlot[slot].seat = seat;
    });
  }

  const humans = lobby.players.filter(p => p.seat < lobby.mode);
  gameState = game.createGame(humans, lobby.mode, lobby.mode === 4 ? lastDeck : null);
  resultRecorded = false;
  lobby.players.forEach(p => { p.ready = false; });

  logger.info(`Game started: ${lobby.mode} players (${humans.length} human)`);
  broadcastGameState();
  scheduleFlow();
}

function handleShuffleMove(socket, data) {
  const player = playerBySocket(socket);
  if (!player || !gameState) return;
  if (gameState.phase !== 'shuffle' || gameState.dealer !== player.seat) return;
  if (shuffleFirstMoveAt === null) shuffleFirstMoveAt = Date.now();
  const x = Number(data && data.x);
  const y = Number(data && data.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return;
  socket.broadcast.volatile.emit('shuffle-move', { x, y });
}

function handleShuffleRiffle(socket) {
  const player = playerBySocket(socket);
  if (!player || !gameState) return;
  if (gameState.phase !== 'shuffle' || gameState.dealer !== player.seat) return;
  socket.broadcast.emit('shuffle-riffle', {});
}

function handleShuffleChop(socket) {
  const player = playerBySocket(socket);
  if (!player || !gameState) return;
  if (gameState.phase !== 'shuffle' || gameState.dealer !== player.seat) return;
  socket.broadcast.emit('shuffle-chop', {});
}

function handleVoteEnd(socket, action) {
  const player = playerBySocket(socket);
  if (!player || !gameState || gameState.gameOver) return;
  if (player.seat >= gameState.mode) return; // spectators don't vote

  if (action === 'propose') {
    if (endVote) return;
    endVote = { agreed: new Set([player.seat]) };
    gameState.lastEvent = `${gameState.players[player.seat].name} proposes ending the match`;
  } else if (action === 'agree') {
    if (!endVote) return;
    endVote.agreed.add(player.seat);
  } else if (action === 'decline') {
    if (!endVote) return;
    endVote = null;
    gameState.lastEvent = `${gameState.players[player.seat].name} declined. The match continues`;
  } else {
    return;
  }

  if (endVote && humanGameSeats().every(s => endVote.agreed.has(s))) {
    clearTimeout(aiTimeout);
    clearTimeout(trickTimeout);
    endVote = null;
    game.endMatchByVote(gameState);
  }
  broadcastGameState();
}

function handleKapothiCall(socket, announce) {
  const player = playerBySocket(socket);
  if (!player || !gameState) return;
  if (gameState.phase !== 'kapothi' || gameState.currentSeat !== player.seat) {
    socket.emit('action-error', { message: 'Not your Kapothi call' });
    return;
  }
  game.decideKapothi(gameState, !!announce);
  broadcastGameState();
  scheduleFlow();
}

function handleShuffleDone(socket, payload) {
  const player = playerBySocket(socket);
  if (!player || !gameState) return;
  if (gameState.phase !== 'shuffle' || gameState.dealer !== player.seat) {
    socket.emit('action-error', { message: 'Not your turn to shuffle' });
    return;
  }
  if (shuffleFirstMoveAt === null || Date.now() - shuffleFirstMoveAt < 2300) {
    socket.emit('action-error', { message: 'Keep washing the cards!' });
    return;
  }
  const entropy = (Array.isArray(payload && payload.entropy) ? payload.entropy : [])
    .slice(0, 4096).map(Number).filter(Number.isFinite);
  if (entropy.length < 40) {
    socket.emit('action-error', { message: 'Keep washing the cards!' });
    return;
  }
  const washMs = Math.min(600000, Math.max(0, Number(payload && payload.washMs) || 0));
  const ops = (Array.isArray(payload && payload.ops) ? payload.ops.slice(0, 24) : [])
    .map(o => {
      if (o && o.t === 'r') return { t: 'r' };
      if (o && o.t === 'o') {
        return { t: 'o', packets: (Array.isArray(o.packets) ? o.packets.slice(0, 40) : []).map(Number) };
      }
      return null;
    });
  if (ops.length < 1 || ops.some(o => !o)) {
    socket.emit('action-error', { message: 'Shuffle the deck first!' });
    return;
  }

  try {
    game.applyShuffle(gameState, { entropy, washMs, ops });
  } catch (e) {
    socket.emit('action-error', { message: 'Invalid shuffle' });
    return;
  }
  broadcastGameState();
  scheduleFlow();
}

function handleCutDone(socket, segments) {
  const player = playerBySocket(socket);
  if (!player || !gameState) return;
  if (gameState.phase !== 'cut' || gameState.breakerSeat !== player.seat) {
    socket.emit('action-error', { message: 'Not your turn to cut' });
    return;
  }
  try {
    game.applyCut(gameState, segments);
  } catch (e) {
    socket.emit('action-error', { message: 'Invalid cut' });
    return;
  }
  broadcastGameState();
  scheduleFlow();
}

function handleChooseTrump(socket, suit) {
  const player = playerBySocket(socket);
  if (!player || !gameState) return;
  if (gameState.phase !== 'trump' || gameState.currentSeat !== player.seat) {
    socket.emit('action-error', { message: 'Not your turn to choose trump' });
    return;
  }
  if (!game.SUITS.includes(suit)) return;

  game.chooseTrump(gameState, suit);
  broadcastGameState();
  scheduleFlow();
}

function handlePlayCard(socket, cardIndex) {
  const player = playerBySocket(socket);
  if (!player || !gameState) return;
  if (gameState.phase !== 'play' || gameState.currentSeat !== player.seat) {
    socket.emit('action-error', { message: 'Not your turn' });
    return;
  }
  try {
    game.playCard(gameState, player.seat, Number(cardIndex));
  } catch (e) {
    socket.emit('action-error', { message: 'Must follow suit!' });
    return;
  }

  broadcastGameState();
  if (gameState.trickJustEnded) {
    finishTrickAfterDelay();
  } else {
    scheduleFlow();
  }
}

function handleReadyNextRound(socket) {
  const player = playerBySocket(socket);
  if (!player || !gameState || !gameState.roundJustEnded || gameState.gameOver) return;
  if (player.ready) return;

  player.ready = true;
  const inGame = lobby.players.filter(p => p.seat < gameState.mode);
  gameState.readyCount = inGame.filter(p => p.ready).length;

  if (inGame.every(p => p.ready)) {
    game.nextRound(gameState);
    lobby.players.forEach(p => { p.ready = false; });
    broadcastGameState();
    scheduleFlow();
  } else {
    broadcastGameState();
  }
}

// The pack never resets between games: gather every card back into a single
// stack (deck + won tricks + table + hands) and keep it for the next 4p game.
function stashDeck(gs) {
  if (!gs || gs.mode !== 4) return;
  const all = gs.deck.slice();
  (gs.wonStacks || []).forEach(st => st.forEach(c => all.push(c)));
  gs.trick.forEach(t => all.push(t.card));
  gs.players.forEach(p => p.hand.forEach(c => all.push(c)));
  if (all.length === 32 && new Set(all).size === 32) lastDeck = all;
}

// Remove a player from the lobby, compact seats, and hand off the host role
// if they held it. Also clears any pending reconnect timer.
function removeFromLobby(player) {
  if (player.graceTimer) { clearTimeout(player.graceTimer); player.graceTimer = null; }
  lobby.players = lobby.players.filter(p => p.id !== player.id);
  lobby.players.forEach((p, i) => { p.seat = i; }); // compact seats in the lobby
  if (lobby.players.length > 0 && player.id === lobby.hostId) lobby.hostId = lobby.players[0].id;
  if (lobby.players.length === 0) { lobby.hostId = null; lobby.mode = 4; lobby.teamPairing = 0; }
}

// The grace window elapsed without the player returning: end the game and send
// everyone back to the lobby (the original behaviour, just delayed).
function expireReconnect(player) {
  if (gameState && !gameState.gameOver) {
    logger.info(`${player.name} did not reconnect; ending the game`);
    clearTimeout(aiTimeout);
    clearTimeout(trickTimeout);
    endVote = null;
    stashDeck(gameState);
    gameState = null;
    io.emit('player-disconnected', { name: player.name });
  }
  removeFromLobby(player);
  broadcastLobbyUpdate();
}

function handleDisconnect(socket) {
  const player = playerBySocket(socket);
  if (!player) return; // unknown, or already replaced by a reconnect

  // Mid-game: hold the seat so a refresh or brief drop can reclaim it.
  if (gameState && !gameState.gameOver) {
    player.connected = false;
    if (player.graceTimer) clearTimeout(player.graceTimer);
    player.graceTimer = setTimeout(
      () => { try { expireReconnect(player); } catch (e) { logger.error('reconnect expiry:', e); } },
      RECONNECT_GRACE_MS
    );
    logger.debug(`${player.name} dropped; holding seat ${player.seat} for reconnect`);
    broadcastGameState();
    return;
  }

  // Otherwise (in the lobby, or after the game is over) leave immediately.
  logger.debug(`${player.name} disconnected`);
  if (gameState && gameState.gameOver) { stashDeck(gameState); gameState = null; }
  removeFromLobby(player);
  broadcastLobbyUpdate();
}

// Attach a returning player to a fresh socket and resume their seat.
function resumePlayer(socket, player) {
  const oldId = player.id;
  const old = io.sockets.sockets.get(oldId);
  if (old && old.id !== socket.id) { try { old.disconnect(true); } catch (e) { /* ignore */ } }
  if (player.graceTimer) { clearTimeout(player.graceTimer); player.graceTimer = null; }
  if (lobby.hostId === oldId) lobby.hostId = socket.id;
  player.id = socket.id;
  player.connected = true;
  wireHandlers(socket);
  socket.emit('session', { token: player.token });
  logger.info(`${player.name} reconnected to seat ${player.seat}`);
  if (gameState) {
    gameState.lastEvent = `${player.name} reconnected`;
    broadcastGameState();
  } else {
    broadcastLobbyUpdate();
  }
}

// ---------- Socket wiring ----------

// Token-bucket per socket: ~20 events/s sustained, small bursts allowed.
// Persistent flooding gets the socket dropped.
function makeLimiter(socket) {
  let tokens = 30;
  let last = Date.now();
  let strikes = 0;
  return function allow(cost) {
    const now = Date.now();
    tokens = Math.min(30, tokens + (now - last) * 0.02);
    last = now;
    if (tokens >= cost) { tokens -= cost; return true; }
    if (++strikes > 300) {
      logger.warn(`Dropped flooding socket ${socket.id}`);
      socket.disconnect(true);
    }
    return false;
  };
}

// Every handler is wrapped so a thrown error is logged and contained rather
// than taking the process down.
function safe(fn) {
  return (...args) => {
    try { fn(...args); } catch (e) { logger.error('Handler error:', e); }
  };
}

// Attach all event handlers to a socket. Used for both fresh connections and
// reconnects, each getting its own rate limiter so listeners never accumulate.
function wireHandlers(socket) {
  const allow = makeLimiter(socket);
  const on = (event, cost, fn) => socket.on(event, safe((payload) => { if (allow(cost)) fn(payload); }));

  on('join', 1, ({ name } = {}) => handleJoin(socket, name));
  on('set-mode', 1, ({ mode } = {}) => handleSetMode(socket, Number(mode)));
  on('set-teams', 1, ({ pairing } = {}) => handleSetTeams(socket, Number(pairing)));
  on('host-start', 1, () => handleHostStart(socket));
  on('choose-trump', 1, ({ suit } = {}) => handleChooseTrump(socket, suit));
  on('shuffle-move', 0.35, (data = {}) => handleShuffleMove(socket, data));
  on('shuffle-riffle', 1, () => handleShuffleRiffle(socket));
  on('shuffle-chop', 1, () => handleShuffleChop(socket));
  on('shuffle-done', 2, (payload = {}) => handleShuffleDone(socket, payload));
  on('vote-end', 1, ({ action } = {}) => handleVoteEnd(socket, String(action || '')));
  on('cut-done', 1, ({ segments } = {}) => handleCutDone(socket, segments));
  on('kapothi-call', 1, ({ announce } = {}) => handleKapothiCall(socket, announce));
  on('play-card', 1, ({ cardIndex } = {}) => handlePlayCard(socket, cardIndex));
  on('ready-next-round', 1, () => handleReadyNextRound(socket));
  socket.on('disconnect', safe(() => handleDisconnect(socket)));
}

function handleConnection(socket) {
  logger.debug(`Socket connected: ${socket.id}`);

  if (io.engine.clientsCount > config.maxSockets) {
    socket.disconnect(true);
    return;
  }

  const token = socket.handshake && socket.handshake.auth && socket.handshake.auth.token;

  // A game is running (or just finished): only a matching token may attach,
  // as a reconnect. Everyone else is turned away.
  if (gameState) {
    const player = token ? lobby.players.find(p => p.token === token) : null;
    if (player) { resumePlayer(socket, player); return; }
    if (!gameState.gameOver) {
      socket.emit('server-error', { message: 'A game is already in progress. Try again later.' });
      socket.disconnect();
      return;
    }
    // game over with an unknown token: fall through to lobby handling
  }

  if (lobby.players.length >= 4) {
    socket.emit('server-error', { message: 'Lobby is full (max 4 players).' });
    socket.disconnect();
    return;
  }

  // A stale token that matches nobody: tell the client to start fresh.
  if (token && !lobby.players.some(p => p.token === token)) {
    socket.emit('session-invalid');
  }

  wireHandlers(socket);
}

module.exports = { init, setJoinQR, handleConnection };
