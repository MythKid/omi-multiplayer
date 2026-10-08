// Table manager: owns the sockets, routes each one to the table it sits at,
// keeps the tables screen up to date, and reaps idle tables. Each Table
// (table.js) runs one isolated match; the pure rules live in game.js.
const config = require('../config');
const logger = require('../utils/logger');
const { sanitizeName } = require('../utils/sanitize');
const Table = require('./table');
const leaderboard = require('./leaderboardService');

// Bumped whenever the client/server event contract changes. A client built
// for another version is told to reload so it picks up matching assets.
const PROTOCOL_VERSION = 2;
const BROWSER_ROOM = 'browser'; // sockets looking at the tables screen
// Sweep often enough to honour the idle timeouts closely (they can be set
// very short for testing), but never more than every 15 s in normal use.
const REAP_INTERVAL_MS = Math.max(250,
  Math.min(15 * 1000, Math.floor(Math.min(config.gameIdleMs, config.lobbyIdleMs) / 4)));
const TABLES_PUSH_MS = 300;     // coalesce tables-screen updates

let io = null;
const tables = [];
const tokenIndex = new Map(); // session token -> Table
let tablesTimer = null;

function init(ioInstance) {
  io = ioInstance;
  for (let id = 1; id <= config.maxSlots; id++) {
    const table = new Table(id, io, {
      detach: (player, notice) => detach(table, player, notice),
      changed: scheduleTablesPush,
    });
    tables.push(table);
  }
  // One sweep for every table: idle games and lobbies free their table.
  const reaper = setInterval(() => {
    const now = Date.now();
    tables.forEach(t => {
      try { t.tick(now); } catch (e) { logger.error(`${t.label} reaper error:`, e); }
    });
  }, REAP_INTERVAL_MS);
  reaper.unref();
}

function tableIds() {
  return tables.map(t => t.id);
}

function tableSummaries() {
  return tables.map(t => t.summary());
}

function scheduleTablesPush() {
  if (tablesTimer || !io) return;
  tablesTimer = setTimeout(() => {
    tablesTimer = null;
    io.to(BROWSER_ROOM).emit('tables', tableSummaries());
  }, TABLES_PUSH_MS);
}

// ---------- Seating ----------

function attach(socket, table) {
  socket.data.table = table;
  socket.leave(BROWSER_ROOM);
  socket.join(table.room);
}

// A table let a player go: forget their token and, if their socket is still
// here, send it back to the tables screen.
function detach(table, player, notice) {
  tokenIndex.delete(player.token);
  const socket = io.sockets.sockets.get(player.id);
  if (!socket) return;
  if (socket.data.table === table) socket.data.table = null;
  socket.leave(table.room);
  socket.join(BROWSER_ROOM);
  socket.emit('table-left', { tableId: table.id, notice: notice || '' });
  socket.emit('tables', tableSummaries());
}

function handleBrowse(socket) {
  if (!socket.data.table) socket.join(BROWSER_ROOM);
  socket.emit('tables', tableSummaries());
}

function handleJoinTable(socket, payload) {
  if (socket.data.table) {
    socket.emit('join-error', { message: 'You are already sitting at a table.' });
    return;
  }
  const id = Number(payload.tableId);
  const table = Number.isInteger(id) ? tables[id - 1] : null;
  if (!table) {
    socket.emit('join-error', { message: 'That table does not exist.' });
    return;
  }
  // All scripts welcome; only control, zero-width and bidi characters go.
  const cleanName = sanitizeName(payload.name, 14);
  if (!cleanName) {
    socket.emit('join-error', { message: 'Please enter a name first.' });
    return;
  }
  const ident = leaderboard.resolveIdentity(cleanName, payload.claim);
  const res = table.addPlayer(socket, cleanName, ident);
  if (res.error) {
    socket.emit('join-error', { message: res.error, tableId: id });
    socket.emit('tables', tableSummaries());
    return;
  }
  attach(socket, table);
  tokenIndex.set(res.player.token, table);
  // A per-player token lets a refreshed or briefly-dropped client reclaim its
  // seat (see handleConnection).
  socket.emit('session', { token: res.player.token });
  socket.emit('table-joined', { tableId: table.id, label: table.label, name: cleanName });
  // Ranking status for this name; a newly issued claim is handed over once
  // for the browser to keep.
  socket.emit('identity', {
    name: cleanName,
    key: ident.key,
    ranked: ident.rankable,
    reason: ident.reason,
    claim: ident.issued ? ident.secret : undefined,
  });
  table.sendChatHistory(socket);
  table.postSystem(`${cleanName} sat down`);
  table.broadcastLobbyUpdate();
  table.notifyChanged();
}

function handleLeaveTable(socket) {
  const table = socket.data.table;
  if (table) table.leave(socket);
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

const asObject = (p) => (p && typeof p === 'object' ? p : {});

function wireHandlers(socket) {
  const allow = makeLimiter(socket);
  const on = (event, cost, fn) =>
    socket.on(event, safe((payload) => { if (allow(cost)) fn(asObject(payload)); }));
  // Game events only make sense at the table this socket sits at.
  const route = (event, cost, fn) => on(event, cost, (p) => {
    const table = socket.data.table;
    if (table) fn(table, p);
  });

  on('browse', 1, () => handleBrowse(socket));
  on('join-table', 2, (p) => handleJoinTable(socket, p));
  on('leave-table', 1, () => handleLeaveTable(socket));
  // Clients cached from before tables existed still send 'join'.
  on('join', 1, () => socket.emit('server-error', {
    message: 'A new version of OMI is available. Please refresh the page.',
  }));

  route('set-mode', 1, (t, p) => t.onSetMode(socket, Number(p.mode)));
  route('set-teams', 1, (t, p) => t.onSetTeams(socket, Number(p.pairing)));
  route('host-start', 1, (t) => t.onHostStart(socket));
  route('choose-trump', 1, (t, p) => t.onChooseTrump(socket, p.suit));
  route('shuffle-move', 0.35, (t, p) => t.onShuffleMove(socket, p));
  route('shuffle-riffle', 1, (t) => t.onShuffleRiffle(socket));
  route('shuffle-chop', 1, (t) => t.onShuffleChop(socket));
  route('shuffle-done', 2, (t, p) => t.onShuffleDone(socket, p));
  route('vote-end', 1, (t, p) => t.onVoteEnd(socket, String(p.action || '')));
  route('cut-done', 1, (t, p) => t.onCutDone(socket, p.segments));
  route('kapothi-call', 1, (t, p) => t.onKapothiCall(socket, p.announce));
  route('play-card', 1, (t, p) => t.onPlayCard(socket, p.cardIndex));
  route('ready-next-round', 1, (t) => t.onReadyNextRound(socket));
  route('results-choice', 1, (t, p) => t.chooseResult(socket, String(p.choice || '')));
  route('chat-send', 1, (t, p) => t.onChat(socket, p.text));

  socket.on('disconnect', safe(() => {
    const table = socket.data.table;
    if (table) table.onDisconnect(socket);
  }));
}

function handleConnection(socket) {
  logger.debug(`Socket connected: ${socket.id}`);

  if (io.engine.clientsCount > config.maxSockets) {
    socket.emit('server-error', { message: 'The server is full right now. Try again in a minute.' });
    socket.disconnect(true);
    return;
  }

  wireHandlers(socket);

  const auth = (socket.handshake && socket.handshake.auth) || {};
  if (auth.v != null && Number(auth.v) !== PROTOCOL_VERSION) {
    socket.emit('version-mismatch', { version: PROTOCOL_VERSION });
    return;
  }

  // A known token reclaims its seat at its table; a stale one is told to
  // start fresh. Everyone else lands on the tables screen.
  const token = typeof auth.token === 'string' ? auth.token : null;
  if (token) {
    const table = tokenIndex.get(token);
    const player = table && table.players.find(p => p.token === token);
    if (player) {
      attach(socket, table);
      table.resumePlayer(socket, player);
      return;
    }
    socket.emit('session-invalid');
  }
}

module.exports = {
  PROTOCOL_VERSION,
  init,
  tableIds,
  tableSummaries,
  handleConnection,
};
