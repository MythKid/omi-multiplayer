// SQLite-backed leaderboard store (better-sqlite3). One row per team, keyed
// by team name, so a repeat entry updates in place. Swapping this for a
// Postgres store later means implementing the same three methods.
const Database = require('better-sqlite3');

class SqliteStore {
  constructor(file) {
    this.db = new Database(file);
    this.db.pragma('journal_mode = WAL'); // safe concurrent reads, durable writes
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS scores (
        team  TEXT PRIMARY KEY,
        score INTEGER NOT NULL,
        date  TEXT NOT NULL
      )
    `);
    // Keep only the higher score when a team plays again.
    this.stmtSubmit = this.db.prepare(`
      INSERT INTO scores (team, score, date) VALUES (@team, @score, @date)
      ON CONFLICT(team) DO UPDATE SET score = excluded.score, date = excluded.date
      WHERE excluded.score > scores.score
    `);
    this.stmtTop = this.db.prepare(
      'SELECT team, score, date FROM scores ORDER BY score DESC, date ASC LIMIT ?'
    );
  }

  submit(team, score, date) {
    this.stmtSubmit.run({ team, score, date });
  }

  top(limit) {
    return this.stmtTop.all(limit);
  }

  close() {
    try { this.db.close(); } catch (e) { /* ignore */ }
  }
}

module.exports = SqliteStore;
