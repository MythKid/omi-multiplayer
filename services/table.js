// One game table. Every table is an isolated match: its own lobby, game
// state, timers, persistent deck and Socket.IO room, so several games run side
// by side without seeing each other. The pure rules live in game.js; the table
// manager (gameManager.js) owns the sockets and routes their events here.
const crypto = require('crypto');
const game = require('../game');
const config = require('../config');
const logger = require('../utils/logger');
const network = require('../utils/network');
const { nameKey } = require('../utils/sanitize');
const leaderboard = require('./leaderboardService');
const { sanitizeMessage, ChatLog, makeChatLimiter } = require('./chat');

// How long a seat is held for a dropped player to return (refresh, brief
// network blip) before the game is ended for the table.
const RECONNECT_GRACE_MS = 90 * 1000;
// How long the results screen stays up before the table returns to its lobby.
const RESULTS_TIMEOUT_MS = 60 * 1000;
const MAX_PLAYERS = 4;

// The three possible 2v2 pairings of the four lobby slots. Partners sit across
// from each other, so at game start slots are remapped to seats with each pair
// on opposite sides. Index 0 keeps the join order.
const TEAM_PAIRINGS = [
  [[0, 2], [1, 3]],
  [[0, 1], [2, 3]],
  [[0, 3], [1, 2]],
];

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
  redeal: 4200, // time to read why the hand is being thrown in
};
const JITTER_PHASES = { play: 800, trump: 800 };
// Phases that advance on a timer for everyone, whoever's seat is current.
const AUTO_PHASES = ['dealing1', 'dealing2', 'redeal'];

class Table {
  // hooks.detach(player, notice) releases a player's socket back to the
  // tables screen; hooks.changed() tells the manager the summary may differ.
  constructor(id, io, hooks) {
    this.id = id;
    this.label = 'Table ' + id;
    this.room = 't:' + id;
    this.io = io;
    this.hooks = hooks;
    this.joinQR = null;

    this.players = [];   // { id, name, seat, ready, connected, token, graceTimer, choice }
    this.mode = 4;
    this.hostId = null;
    this.teamPairing = 0;

    this.gameState = null;          // null = in the lobby
    this.endVote = null;            // { agreed: Set<seat> } while an end-match vote is live
    this.resultRecorded = false;    // a finished game is recorded only once
    this.shuffleFirstMoveAt = null; // wall-clock start of the current human wash
    this.lastDeck = null;           // the physical pack survives between games (4p)

    this.aiTimeout = null;
    this.trickTimeout = null;
    this.resultsTimer = null;
    // Bumped whenever a game starts or ends, so a timer scheduled for one
    // game can never fire into the next one at the same table.
    this.gen = 0;

    this.lobbyActiveAt = Date.now();
    this.awaiting = { key: '', since: 0, warned: false };
    this.summaryKey = '';
    this.chat = new ChatLog();
  }

  // ---------- Status ----------

  status() {
    if (this.gameState) return this.gameState.gameOver ? 'finished' : 'playing';
    if (this.players.length === 0) return 'empty';
    if (this.players.length >= MAX_PLAYERS) return 'full';
    return 'open';
  }

  canJoin() {
    const s = this.status();
    return s === 'empty' || s === 'open';
  }

  // Public summary for the tables screen and GET /api/tables.
  summary() {
    const gs = this.gameState;
    const out = {
      id: this.id,
      label: this.label,
      status: this.status(),
      mode: gs ? gs.mode : this.mode,
      humans: this.players.length,
      seats: MAX_PLAYERS,
      names: this.players.slice().sort((a, b) => a.seat - b.seat).map(p => p.name),
      canJoin: this.canJoin(),
    };
    if (gs) {
      out.round = gs.roundNum;
      out.score = gs.mode === 4
        ? [0, 1].map(t => gs.players.find(p => p.team === t).score)
        : gs.players.map(p => p.score);
    }
    return out;
  }

  notifyChanged() {
    const key = JSON.stringify(this.summary());
    if (key === this.summaryKey) return;
    this.summaryKey = key;
    this.hooks.changed();
  }

  // ---------- Helpers ----------

  socketOf(player) {
    return this.io.sockets.sockets.get(player.id);
  }

  playerBySocket(socket) {
    return this.players.find(p => p.id === socket.id);
  }

  emitRoom(event, payload) {
    this.io.to(this.room).emit(event, payload);
  }

  joinURL() {
    return `${network.getJoinURL()}/?table=${this.id}`;
  }

  touchLobby() {
    this.lobbyActiveAt = Date.now();
  }

  clearGrace(player) {
    if (player.graceTimer) { clearTimeout(player.graceTimer); player.graceTimer = null; }
  }

  // Humans actually seated in the running game
  humanGameSeats() {
    if (!this.gameState) return [];
    return this.players.filter(p => p.seat < this.gameState.mode).map(p => p.seat);
  }

  broadcastLobbyUpdate() {
    const host = this.players.find(p => p.id === this.hostId);
    const joinHost = network.getJoinHost();
    const payload = {
      tableId: this.id,
      label: this.label,
      players: this.players.map(p => ({ name: p.name, seat: p.seat })),
      mode: this.mode,
      hostSeat: host ? host.seat : 0,
      serverIP: network.getLocalIP(),
      serverPort: config.port,
      joinURL: this.joinURL(),
      joinAltURL: joinHost && !config.publicUrl
        ? `http://${joinHost}:${config.port}/?table=${this.id}`
        : '',
      joinQR: this.joinQR,
      teamPairing: this.teamPairing,
    };
    this.players.forEach(p => {
      const socket = this.socketOf(p);
      if (!socket) return;
      socket.emit('lobby-update', { ...payload, isHost: p.id === this.hostId, yourSeat: p.seat });
    });
  }

  buildClientState(gs, forSeat) {
    // While trump is being chosen, the caller's partner may not look at any
    // cards, their own included. The hand is withheld here on the server, so
    // no client (or reconnect) can ever see it early. Opponents look as usual.
    const lockedSeat = gs.mode === 4 && gs.phase === 'trump' ? (gs.trumpCallerSeat + 2) % 4 : -1;
    const own = gs.players[forSeat] ? gs.players[forSeat].hand : [];
    const locked = forSeat === lockedSeat;
    return {
      tableId: this.id,
      tableLabel: this.label,
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
      endVote: this.endVote ? { agreedSeats: Array.from(this.endVote.agreed) } : null,
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
      myHand: locked ? [] : own,
      myHandLocked: locked ? own.length : 0,
      mySeat: forSeat,
      redeal: gs.phase === 'redeal' ? gs.redealInfo : null,
      redealCount: gs.redealsThisRound || 0,
      readyCount: gs.readyCount || 0,
      totalPlayers: gs.players.length,
      // Seats whose human is currently disconnected but still within the
      // reconnect grace window, so clients can show a "waiting" banner.
      disconnectedSeats: this.players
        .filter(p => p.connected === false && p.seat < gs.mode)
        .map(p => ({ seat: p.seat, name: p.name })),
      // Once the match is over: who has chosen to stay for a rematch.
      results: gs.gameOver ? {
        stayed: this.players.filter(p => p.choice === 'stay').length,
        total: this.players.length,
      } : null,
    };
  }

  // When a 4-player game ends with a two-human winning team, record the team's
  // final score on the leaderboard. Runs at most once per game.
  recordResultIfFinished() {
    const gs = this.gameState;
    if (!gs || !gs.gameOver || this.resultRecorded) return;
    this.resultRecorded = true;
    if (gs.mode !== 4) return;

    const winner = gs.gameWinner;
    if (winner !== 'Team A' && winner !== 'Team B') return; // draw or no winner
    const seats = winner === 'Team A' ? [0, 2] : [1, 3];

    const humanBySeat = {};
    this.players.forEach(p => { if (p.seat < gs.mode) humanBySeat[p.seat] = p; });
    const a = humanBySeat[seats[0]];
    const b = humanBySeat[seats[1]];
    if (!a || !b) return; // a bot was on the winning team, skip

    leaderboard.submitTeamResult(a.name, b.name, gs.players[seats[0]].score);
  }

  broadcastGameState() {
    const gs = this.gameState;
    if (!gs) return;
    this.recordResultIfFinished();
    if (gs.gameOver && !this.resultsTimer) {
      const gen = this.gen;
      this.resultsTimer = setTimeout(() => {
        if (this.gen === gen) this.safely(() => this.finishResults());
      }, RESULTS_TIMEOUT_MS);
    }

    this.players.forEach(player => {
      const socket = this.socketOf(player);
      if (!socket) return;
      socket.emit('state-update', this.buildClientState(gs, player.seat));
    });

    gs.lastEvent = ''; // toast events are one-shot
    if (gs.phase !== 'shuffle') this.shuffleFirstMoveAt = null;
    this.refreshAwaiting();
    this.notifyChanged();
  }

  // Timer callbacks run outside the socket handlers' try/catch.
  safely(fn) {
    try { fn(); } catch (e) { logger.error(`${this.label} timer error:`, e); }
  }

  // ---------- Idle tracking ----------

  // What the game is currently waiting on a human for, as a key that changes
  // whenever the wait moves on. '' when nothing waits on a human.
  awaitingKey() {
    const gs = this.gameState;
    if (!gs || gs.gameOver) return '';
    const humans = this.humanGameSeats();
    if (gs.roundJustEnded) return humans.length ? 'ready:' + gs.roundNum : '';
    if (gs.trickJustEnded || AUTO_PHASES.includes(gs.phase)) return '';
    return humans.includes(gs.currentSeat) ? `seat:${gs.currentSeat}:${gs.phase}` : '';
  }

  refreshAwaiting() {
    const key = this.awaitingKey();
    if (key !== this.awaiting.key) this.awaiting = { key, since: Date.now(), warned: false };
  }

  // A valid action from the awaited seat restarts its idle clock.
  markActive(seat) {
    if (this.awaiting.key.startsWith(`seat:${seat}:`)) {
      this.awaiting.since = Date.now();
      this.awaiting.warned = false;
    }
  }

  // The seat blamed when the wait runs out.
  idleSeat() {
    const key = this.awaiting.key;
    if (key.startsWith('seat:')) return Number(key.split(':')[1]);
    const gs = this.gameState;
    const notReady = this.players
      .filter(p => gs && p.seat < gs.mode && !p.ready)
      .sort((a, b) => a.seat - b.seat);
    return notReady.length ? notReady[0].seat : -1;
  }

  // Called by the manager's reaper every few seconds.
  tick(now) {
    const gs = this.gameState;
    if (gs && !gs.gameOver) {
      const a = this.awaiting;
      if (!a.key) return;
      const idle = now - a.since;
      const warnAt = config.gameIdleMs - Math.min(60 * 1000, config.gameIdleMs / 2);
      if (idle >= config.gameIdleMs) {
        const seat = this.idleSeat();
        if (seat >= 0) this.abandon(seat, 'idle');
        return;
      }
      if (!a.warned && idle >= warnAt) {
        a.warned = true;
        const seat = this.idleSeat();
        const name = seat >= 0 ? gs.players[seat].name : 'Someone';
        this.emitRoom('table-notice', {
          message: `${name}, are you still there? The game ends soon if nobody moves.`,
        });
      }
    } else if (!gs && this.players.length && now - this.lobbyActiveAt >= config.lobbyIdleMs) {
      this.closeLobby();
    }
  }

  // ---------- Flow ----------

  finishTrickAfterDelay() {
    clearTimeout(this.trickTimeout);
    const gen = this.gen;
    this.trickTimeout = setTimeout(() => this.safely(() => {
      const gs = this.gameState;
      if (this.gen !== gen || !gs || gs.gameOver || gs.roundJustEnded) return;
      game.endTrick(gs);
      this.broadcastGameState();
      if (!gs.roundJustEnded) this.scheduleFlow();
    }), 2300); // window for the trick-gather animation
  }

  scheduleFlow() {
    const gs = this.gameState;
    if (!gs) return;
    if (gs.trickJustEnded || gs.roundJustEnded) return;
    const phase = gs.phase;
    const isAuto = AUTO_PHASES.includes(phase);
    if (!isAuto && this.humanGameSeats().includes(gs.currentSeat)) return; // human acts

    clearTimeout(this.aiTimeout);
    const gen = this.gen;
    this.aiTimeout = setTimeout(() => this.safely(() => {
      if (this.gen !== gen || !this.gameState || this.gameState.phase !== phase) return;
      this.runAutoStep(phase);
    }), (PHASE_DELAYS[phase] || 1400) + Math.random() * (JITTER_PHASES[phase] || 0));
  }

  runAutoStep(phase) {
    const gs = this.gameState;
    const currentSeat = gs.currentSeat;

    if (phase === 'shuffle') {
      const entropy = Array.from({ length: 64 }, () => Math.random() * 1e6);
      // AI mixes like a person would: an overhand pass then two riffles
      const packets = [];
      let rem = gs.deck.length;
      while (rem > 0) {
        const s = Math.min(rem, 2 + Math.floor(Math.random() * 5));
        packets.push(s);
        rem -= s;
      }
      game.applyShuffle(gs, {
        entropy,
        washMs: 3000,
        ops: [{ t: 'o', packets }, { t: 'r' }, { t: 'r' }],
      });
    } else if (phase === 'cut') {
      const k = 8 + Math.floor(Math.random() * 17); // cut somewhere mid-deck
      game.applyCut(gs, [[k, 32], [0, k]]);
    } else if (phase === 'dealing1') {
      game.dealStage1(gs);
    } else if (phase === 'dealing2') {
      game.dealStage2(gs);
      if (gs.phase === 'redeal') {
        const { counts, shortTeam } = gs.redealInfo;
        this.postSystem(`Redeal: Team ${'AB'[shortTeam]} held only ${counts[shortTeam]} trump(s). ` +
          `${gs.players[gs.dealer].name} reshuffles.`);
      }
    } else if (phase === 'redeal') {
      game.redealRound(gs);
    } else if (phase === 'trump') {
      game.chooseTrump(gs, game.aiPickTrump(gs, currentSeat));
    } else if (phase === 'kapothi') {
      game.decideKapothi(gs, game.aiDecideKapothi(gs, currentSeat));
    } else if (phase === 'play') {
      game.playCard(gs, currentSeat, game.aiPickCard(gs, currentSeat));
      this.broadcastGameState();
      if (gs.trickJustEnded) {
        this.finishTrickAfterDelay();
      } else {
        this.scheduleFlow();
      }
      return;
    }

    this.broadcastGameState();
    this.scheduleFlow();
  }

  clearGameTimers() {
    clearTimeout(this.aiTimeout);
    clearTimeout(this.trickTimeout);
    clearTimeout(this.resultsTimer);
    this.aiTimeout = null;
    this.trickTimeout = null;
    this.resultsTimer = null;
  }

  // Drop the running or finished game and invalidate its timers.
  endGame() {
    this.clearGameTimers();
    this.gen++;
    this.gameState = null;
    this.endVote = null;
    this.shuffleFirstMoveAt = null;
    this.awaiting = { key: '', since: 0, warned: false };
  }

  // The pack never resets between games: gather every card back into a single
  // stack (deck + won tricks + table + hands) and keep it for the next 4p game.
  stashDeck(gs) {
    if (!gs || gs.mode !== 4) return;
    const all = gs.deck.slice();
    (gs.wonStacks || []).forEach(st => st.forEach(c => all.push(c)));
    gs.trick.forEach(t => all.push(t.card));
    gs.players.forEach(p => p.hand.forEach(c => all.push(c)));
    if (all.length === 32 && new Set(all).size === 32) this.lastDeck = all;
  }

  // Back in the lobby: close seat gaps (keeping the game's seat order, so
  // partners stay across from each other) and reset per-game flags.
  regroupLobby() {
    this.players.sort((a, b) => a.seat - b.seat);
    this.players.forEach((p, i) => { p.seat = i; p.ready = false; p.choice = null; });
    this.teamPairing = 0;
    if (!this.players.some(p => p.id === this.hostId)) {
      this.hostId = this.players.length ? this.players[0].id : null;
    }
    if (this.players.length === 0) this.resetEmpty();
    this.touchLobby();
  }

  resetEmpty() {
    this.hostId = null;
    this.mode = 4;
    this.teamPairing = 0;
    this.chat.clear(); // a new group starts with a clean slate
    this.touchLobby();
  }

  // Take a player off the table and hand their socket back to the manager.
  release(player, notice) {
    this.clearGrace(player);
    this.players = this.players.filter(p => p !== player);
    this.hooks.detach(player, notice || null);
    if (this.players.length) this.postSystem(`${player.name} left the table`);
  }

  // ---------- Chat ----------

  postSystem(text) {
    this.emitRoom('chat-message', this.chat.add({ kind: 'system', text }));
  }

  sendChatHistory(socket) {
    socket.emit('chat-history', this.chat.list());
  }

  onChat(socket, text) {
    const player = this.playerBySocket(socket);
    if (!player) return;
    const clean = sanitizeMessage(text);
    if (!clean) return;
    const verdict = player.chatAllow(clean);
    if (verdict !== 'ok') {
      socket.emit('chat-error', {
        message: verdict === 'repeat' ? 'You just said that.' : 'Slow down a little.',
      });
      return;
    }
    if (!this.gameState) this.touchLobby();
    const gs = this.gameState;
    const inGame = gs && player.seat < gs.mode;
    this.emitRoom('chat-message', this.chat.add({
      kind: 'user',
      seat: player.seat,
      inGame: !!inGame,
      team: inGame && gs.mode === 4 ? gs.players[player.seat].team : null,
      name: player.name,
      text: clean,
    }));
  }

  // ---------- Membership ----------

  addPlayer(socket, cleanName) {
    if (!this.canJoin()) {
      return { error: this.gameState ? 'That table is already playing. Pick another one.' : 'That table is full.' };
    }
    const key = nameKey(cleanName);
    if (this.players.some(p => nameKey(p.name) === key)) {
      return { error: 'Someone at this table already uses that name. Pick another name.' };
    }
    const seat = this.players.length;
    if (seat === 0) { this.resetEmpty(); this.hostId = socket.id; }
    const player = {
      id: socket.id,
      name: cleanName,
      seat,
      ready: false,
      connected: true,
      token: crypto.randomUUID(),
      graceTimer: null,
      choice: null,
      chatAllow: makeChatLimiter(),
    };
    this.players.push(player);
    this.touchLobby();
    logger.debug(`${this.label}: ${cleanName} joined (seat ${seat})`);
    // The manager attaches the socket to the room, then announces the join.
    return { player };
  }

  // Explicit leave. In the lobby the seat is freed at once; after the match
  // it counts as a "leave" choice; mid-game it abandons the match.
  leave(socket) {
    const player = this.playerBySocket(socket);
    if (!player) return;
    const gs = this.gameState;
    if (gs && !gs.gameOver) {
      this.abandon(player.seat, 'left');
      return;
    }
    if (gs) {
      this.chooseResult(socket, 'leave');
      return;
    }
    this.release(player);
    this.regroupLobby();
    this.broadcastLobbyUpdate();
    this.notifyChanged();
  }

  // Lobby went quiet for too long: free the table for someone else.
  closeLobby() {
    logger.info(`${this.label}: closing idle lobby`);
    const notice = `${this.label} closed after a long time without a game.`;
    this.players.slice().forEach(p => this.release(p, notice));
    this.resetEmpty();
    this.notifyChanged();
  }

  // End the running match because a player left, dropped for good, or sat
  // idle. Everyone else returns to this table's lobby.
  abandon(leaverSeat, reason) {
    const gs = this.gameState;
    if (!gs || gs.gameOver) return;
    const leaver = this.players.find(p => p.seat === leaverSeat) || null;
    const name = leaver ? leaver.name : (gs.players[leaverSeat] || {}).name || 'A player';
    logger.info(`${this.label}: ${name} ${reason}; ending the game`);

    this.stashDeck(gs);
    this.endGame();

    const notice = reason === 'idle'
      ? `You were removed from ${this.label} for being idle too long.`
      : null;
    this.players
      .filter(p => p === leaver || !p.connected)
      .forEach(p => this.release(p, p === leaver ? notice : null));
    this.regroupLobby();

    this.emitRoom('game-abandoned', { name, reason });
    this.broadcastLobbyUpdate();
    this.notifyChanged();
  }

  // A results-screen choice: stay for a rematch, or leave the table.
  chooseResult(socket, choice) {
    const player = this.playerBySocket(socket);
    const gs = this.gameState;
    if (!player || !gs || !gs.gameOver) return;
    if (choice === 'leave') {
      // No seat compaction while the finished game is still on screen.
      this.release(player);
    } else if (choice === 'stay') {
      if (player.choice) return;
      player.choice = 'stay';
    } else {
      return;
    }
    if (this.players.every(p => p.choice === 'stay')) this.finishResults();
    else this.broadcastGameState();
  }

  // Close the results screen: the finished game goes away and whoever is
  // still here lands in the table's lobby, ready for a rematch.
  finishResults() {
    if (!this.gameState) return;
    this.stashDeck(this.gameState);
    this.endGame();
    // Anyone still disconnected at this point has left.
    this.players.filter(p => !p.connected).forEach(p => this.release(p));
    this.regroupLobby();
    this.broadcastLobbyUpdate();
    this.notifyChanged();
  }

  onDisconnect(socket) {
    const player = this.playerBySocket(socket);
    if (!player) return; // unknown, or already replaced by a reconnect
    const gs = this.gameState;

    // Mid-game: hold the seat so a refresh or brief drop can reclaim it.
    if (gs && !gs.gameOver) {
      player.connected = false;
      this.clearGrace(player);
      player.graceTimer = setTimeout(
        () => this.safely(() => this.expireReconnect(player)),
        RECONNECT_GRACE_MS
      );
      logger.debug(`${this.label}: ${player.name} dropped; holding seat ${player.seat}`);
      this.postSystem(`${player.name} lost connection`);
      this.broadcastGameState();
      return;
    }

    // Results screen: dropping out counts as leaving.
    if (gs) {
      player.connected = false;
      this.chooseResult(socket, 'leave');
      return;
    }

    // Lobby: leave immediately.
    logger.debug(`${this.label}: ${player.name} disconnected`);
    this.release(player);
    this.regroupLobby();
    this.broadcastLobbyUpdate();
    this.notifyChanged();
  }

  // The grace window elapsed without the player returning.
  expireReconnect(player) {
    player.graceTimer = null;
    if (!this.players.includes(player) || player.connected) return;
    const gs = this.gameState;
    if (gs && !gs.gameOver) {
      this.abandon(player.seat, 'disconnect');
    } else if (gs) {
      this.release(player);
      if (this.players.every(p => p.choice === 'stay')) this.finishResults();
      else this.broadcastGameState();
    } else {
      this.release(player);
      this.regroupLobby();
      this.broadcastLobbyUpdate();
      this.notifyChanged();
    }
  }

  // Attach a returning player to a fresh socket and resume their seat.
  resumePlayer(socket, player) {
    const oldId = player.id;
    const old = this.io.sockets.sockets.get(oldId);
    this.clearGrace(player);
    if (this.hostId === oldId) this.hostId = socket.id;
    player.id = socket.id;
    player.connected = true;
    // Retire a still-open older socket (a duplicated tab) only after the seat
    // has moved, so its disconnect is not mistaken for this player dropping.
    if (old && old.id !== socket.id) {
      old.data.table = null;
      try { old.disconnect(true); } catch (e) { /* ignore */ }
    }
    socket.emit('session', { token: player.token });
    this.sendChatHistory(socket);
    logger.info(`${this.label}: ${player.name} reconnected to seat ${player.seat}`);
    this.postSystem(`${player.name} is back`);
    if (this.gameState) {
      this.gameState.lastEvent = `${player.name} reconnected`;
      this.broadcastGameState();
    } else {
      this.broadcastLobbyUpdate();
    }
  }

  // ---------- Lobby handlers ----------

  onSetMode(socket, mode) {
    if (socket.id !== this.hostId || this.gameState) return;
    if (![2, 3, 4].includes(mode)) return;
    this.mode = mode;
    this.touchLobby();
    this.broadcastLobbyUpdate();
    this.notifyChanged();
  }

  onSetTeams(socket, pairing) {
    if (socket.id !== this.hostId || this.gameState) return;
    if (this.mode !== 4) return;
    if (![0, 1, 2].includes(pairing)) return;
    this.teamPairing = pairing;
    this.touchLobby();
    this.broadcastLobbyUpdate();
  }

  onHostStart(socket) {
    if (socket.id !== this.hostId || this.gameState) return;
    if (this.players.length < 1) return;

    // 4p: remap lobby slots to game seats so the chosen partners sit across
    // from each other (teams are seat 0+2 vs seat 1+3).
    if (this.mode === 4) {
      const pairs = TEAM_PAIRINGS[this.teamPairing] || TEAM_PAIRINGS[0];
      const order = [pairs[0][0], pairs[1][0], pairs[0][1], pairs[1][1]];
      const bySlot = {};
      this.players.forEach(p => { bySlot[p.seat] = p; });
      order.forEach((slot, seat) => {
        if (bySlot[slot]) bySlot[slot].seat = seat;
      });
    }

    const humans = this.players.filter(p => p.seat < this.mode);
    this.gen++;
    this.gameState = game.createGame(humans, this.mode, this.mode === 4 ? this.lastDeck : null);
    this.resultRecorded = false;
    this.endVote = null;
    this.players.forEach(p => { p.ready = false; p.choice = null; });

    logger.info(`${this.label}: game started, ${this.mode} players (${humans.length} human)`);
    this.postSystem('The game has started. Good luck!');
    this.broadcastGameState();
    this.scheduleFlow();
  }

  // ---------- Game handlers ----------

  dealerAction(socket) {
    const player = this.playerBySocket(socket);
    const gs = this.gameState;
    if (!player || !gs) return null;
    if (gs.phase !== 'shuffle' || gs.dealer !== player.seat) return null;
    return player;
  }

  onShuffleMove(socket, data) {
    const player = this.dealerAction(socket);
    if (!player) return;
    if (this.shuffleFirstMoveAt === null) this.shuffleFirstMoveAt = Date.now();
    const x = Number(data && data.x);
    const y = Number(data && data.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    this.markActive(player.seat);
    socket.to(this.room).volatile.emit('shuffle-move', { x, y });
  }

  onShuffleRiffle(socket) {
    const player = this.dealerAction(socket);
    if (!player) return;
    this.markActive(player.seat);
    socket.to(this.room).emit('shuffle-riffle', {});
  }

  onShuffleChop(socket) {
    const player = this.dealerAction(socket);
    if (!player) return;
    this.markActive(player.seat);
    socket.to(this.room).emit('shuffle-chop', {});
  }

  onVoteEnd(socket, action) {
    const player = this.playerBySocket(socket);
    const gs = this.gameState;
    if (!player || !gs || gs.gameOver) return;
    if (player.seat >= gs.mode) return; // players outside the mode don't vote

    if (action === 'propose') {
      if (this.endVote) return;
      this.endVote = { agreed: new Set([player.seat]) };
      gs.lastEvent = `${gs.players[player.seat].name} proposes ending the match`;
    } else if (action === 'agree') {
      if (!this.endVote) return;
      this.endVote.agreed.add(player.seat);
    } else if (action === 'decline') {
      if (!this.endVote) return;
      this.endVote = null;
      gs.lastEvent = `${gs.players[player.seat].name} declined. The match continues`;
    } else {
      return;
    }

    if (this.endVote && this.humanGameSeats().every(s => this.endVote.agreed.has(s))) {
      clearTimeout(this.aiTimeout);
      clearTimeout(this.trickTimeout);
      this.endVote = null;
      game.endMatchByVote(gs);
    }
    this.broadcastGameState();
  }

  onKapothiCall(socket, announce) {
    const player = this.playerBySocket(socket);
    const gs = this.gameState;
    if (!player || !gs) return;
    if (gs.phase !== 'kapothi' || gs.currentSeat !== player.seat) {
      socket.emit('action-error', { message: 'Not your Kapothi call' });
      return;
    }
    game.decideKapothi(gs, !!announce);
    this.broadcastGameState();
    this.scheduleFlow();
  }

  onShuffleDone(socket, payload) {
    const player = this.playerBySocket(socket);
    const gs = this.gameState;
    if (!player || !gs) return;
    if (gs.phase !== 'shuffle' || gs.dealer !== player.seat) {
      socket.emit('action-error', { message: 'Not your turn to shuffle' });
      return;
    }
    if (this.shuffleFirstMoveAt === null || Date.now() - this.shuffleFirstMoveAt < 2300) {
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
      game.applyShuffle(gs, { entropy, washMs, ops });
    } catch (e) {
      socket.emit('action-error', { message: 'Invalid shuffle' });
      return;
    }
    this.broadcastGameState();
    this.scheduleFlow();
  }

  onCutDone(socket, segments) {
    const player = this.playerBySocket(socket);
    const gs = this.gameState;
    if (!player || !gs) return;
    if (gs.phase !== 'cut' || gs.breakerSeat !== player.seat) {
      socket.emit('action-error', { message: 'Not your turn to cut' });
      return;
    }
    try {
      game.applyCut(gs, segments);
    } catch (e) {
      socket.emit('action-error', { message: 'Invalid cut' });
      return;
    }
    this.broadcastGameState();
    this.scheduleFlow();
  }

  onChooseTrump(socket, suit) {
    const player = this.playerBySocket(socket);
    const gs = this.gameState;
    if (!player || !gs) return;
    if (gs.phase !== 'trump' || gs.currentSeat !== player.seat) {
      socket.emit('action-error', { message: 'Not your turn to choose trump' });
      return;
    }
    if (!game.SUITS.includes(suit)) return;

    game.chooseTrump(gs, suit);
    this.broadcastGameState();
    this.scheduleFlow();
  }

  onPlayCard(socket, cardIndex) {
    const player = this.playerBySocket(socket);
    const gs = this.gameState;
    if (!player || !gs) return;
    if (gs.phase !== 'play' || gs.currentSeat !== player.seat) {
      socket.emit('action-error', { message: 'Not your turn' });
      return;
    }
    try {
      game.playCard(gs, player.seat, Number(cardIndex));
    } catch (e) {
      socket.emit('action-error', { message: 'Must follow suit!' });
      return;
    }

    this.markActive(player.seat);
    this.broadcastGameState();
    if (gs.trickJustEnded) {
      this.finishTrickAfterDelay();
    } else {
      this.scheduleFlow();
    }
  }

  onReadyNextRound(socket) {
    const player = this.playerBySocket(socket);
    const gs = this.gameState;
    if (!player || !gs || !gs.roundJustEnded || gs.gameOver) return;
    if (player.ready) return;

    player.ready = true;
    const inGame = this.players.filter(p => p.seat < gs.mode);
    gs.readyCount = inGame.filter(p => p.ready).length;

    if (inGame.every(p => p.ready)) {
      game.nextRound(gs);
      this.players.forEach(p => { p.ready = false; });
      this.broadcastGameState();
      this.scheduleFlow();
    } else {
      this.broadcastGameState();
    }
  }
}

Table.MAX_PLAYERS = MAX_PLAYERS;

module.exports = Table;
