// Database access point. Picks a storage backend and hands back one object
// with a stable interface: getPlayer, recordMatch, topPlayers, playerMatches,
// recentMatches, getMatch, countLineupSince, counts and close. The rest of
// the app never imports a concrete store directly, so replacing SQLite with
// Postgres later is a change confined to this folder.
const fs = require('fs');
const path = require('path');
const config = require('../config');
const logger = require('../utils/logger');
const JsonStore = require('./jsonStore');

let store = null;

function createStore() {
  fs.mkdirSync(config.dataDir, { recursive: true });

  const wantSqlite = config.dbDriver === 'sqlite' || config.dbDriver === 'auto';
  if (wantSqlite) {
    try {
      const SqliteStore = require('./sqliteStore');
      const s = new SqliteStore(path.join(config.dataDir, 'leaderboard.db'));
      logger.info('Leaderboard storage: SQLite');
      return s;
    } catch (e) {
      // Native module missing (e.g. inside the packaged exe) or failed to
      // load. Fall back to the portable JSON store unless SQLite was forced.
      if (config.dbDriver === 'sqlite') logger.error('SQLite requested but unavailable:', e.message);
      else logger.warn('SQLite unavailable, using JSON storage:', e.message);
    }
  }

  // A new file: the old best-score leaderboard.json is left as it was.
  const s = new JsonStore(path.join(config.dataDir, 'leaderboard-v2.json'));
  logger.info('Leaderboard storage: JSON file');
  return s;
}

function getStore() {
  if (!store) store = createStore();
  return store;
}

function closeStore() {
  if (store) { store.close(); store = null; }
}

module.exports = { getStore, closeStore };
