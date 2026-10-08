// SQLite-backed leaderboard store (better-sqlite3): rated players, recorded
// matches, and each seat's line in every match. A match and every rating it
// changes are written in one transaction. The original best-score table
// ("scores") is left in the file untouched; this store simply does not use it.
const Database = require('better-sqlite3');

const SEAT_COLUMNS = 'seat, team, player_key, name, is_bot, rated, rating_before, rating_after, ' +
  'delta, grade, grade_score, tricks, calls, calls_made';

class SqliteStore {
  constructor(file) {
    this.db = new Database(file);
    this.db.pragma('journal_mode = WAL'); // safe concurrent reads, durable writes
    this.db.pragma('foreign_keys = ON');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS players (
        key         TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        rating      REAL NOT NULL,
        games       INTEGER NOT NULL DEFAULT 0,
        wins        INTEGER NOT NULL DEFAULT 0,
        losses      INTEGER NOT NULL DEFAULT 0,
        draws       INTEGER NOT NULL DEFAULT 0,
        grade_sum   REAL NOT NULL DEFAULT 0,
        best_rating REAL NOT NULL,
        last_delta  REAL NOT NULL DEFAULT 0,
        last_played TEXT,
        claim_hash  TEXT NOT NULL,
        created_at  TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS matches (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        played_at    TEXT NOT NULL,
        table_id     INTEGER,
        end_reason   TEXT NOT NULL,
        rated        INTEGER NOT NULL,
        winner_team  INTEGER,
        score_a      INTEGER NOT NULL,
        score_b      INTEGER NOT NULL,
        rounds       INTEGER NOT NULL,
        redeals      INTEGER NOT NULL DEFAULT 0,
        lineup_key   TEXT NOT NULL,
        note         TEXT NOT NULL DEFAULT '',
        summary_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_matches_lineup ON matches (lineup_key, played_at);
      CREATE TABLE IF NOT EXISTS match_players (
        match_id      INTEGER NOT NULL REFERENCES matches (id) ON DELETE CASCADE,
        seat          INTEGER NOT NULL,
        team          INTEGER NOT NULL,
        player_key    TEXT,
        name          TEXT NOT NULL,
        is_bot        INTEGER NOT NULL,
        rated         INTEGER NOT NULL,
        rating_before REAL,
        rating_after  REAL,
        delta         REAL,
        grade         TEXT,
        grade_score   REAL,
        tricks        INTEGER,
        calls         INTEGER,
        calls_made    INTEGER,
        PRIMARY KEY (match_id, seat)
      );
      CREATE INDEX IF NOT EXISTS idx_match_players_key ON match_players (player_key, match_id DESC);
    `);

    this.stmt = {
      getPlayer: this.db.prepare('SELECT * FROM players WHERE key = ?'),
      insertPlayer: this.db.prepare(`
        INSERT INTO players (key, name, rating, games, wins, losses, draws, grade_sum,
          best_rating, last_delta, last_played, claim_hash, created_at)
        VALUES (@key, @name, @rating, @games, @wins, @losses, @draws, @grade_sum,
          @best_rating, @last_delta, @last_played, @claim_hash, @created_at)`),
      updatePlayer: this.db.prepare(`
        UPDATE players SET name = @name, rating = @rating, games = @games, wins = @wins,
          losses = @losses, draws = @draws, grade_sum = @grade_sum, best_rating = @best_rating,
          last_delta = @last_delta, last_played = @last_played
        WHERE key = @key`),
      insertMatch: this.db.prepare(`
        INSERT INTO matches (played_at, table_id, end_reason, rated, winner_team, score_a, score_b,
          rounds, redeals, lineup_key, note, summary_json)
        VALUES (@played_at, @table_id, @end_reason, @rated, @winner_team, @score_a, @score_b,
          @rounds, @redeals, @lineup_key, @note, @summary_json)`),
      insertSeat: this.db.prepare(`
        INSERT INTO match_players (match_id, ${SEAT_COLUMNS})
        VALUES (@match_id, @seat, @team, @player_key, @name, @is_bot, @rated, @rating_before,
          @rating_after, @delta, @grade, @grade_score, @tricks, @calls, @calls_made)`),
      topPlayers: this.db.prepare(`
        SELECT * FROM players WHERE games > 0
        ORDER BY rating DESC, games DESC, name ASC LIMIT ?`),
      playerMatchIds: this.db.prepare(`
        SELECT match_id FROM match_players WHERE player_key = ?
        ORDER BY match_id DESC LIMIT ?`),
      recentMatchIds: this.db.prepare('SELECT id FROM matches ORDER BY id DESC LIMIT ?'),
      getMatch: this.db.prepare('SELECT * FROM matches WHERE id = ?'),
      getSeats: this.db.prepare(`SELECT ${SEAT_COLUMNS} FROM match_players WHERE match_id = ? ORDER BY seat`),
      countLineup: this.db.prepare(
        'SELECT COUNT(*) AS n FROM matches WHERE lineup_key = ? AND rated = 1 AND played_at >= ?'),
      counts: this.db.prepare(`
        SELECT (SELECT COUNT(*) FROM players WHERE games > 0) AS players,
               (SELECT COUNT(*) FROM matches) AS matches`),
    };

    // One transaction for the whole match: either everything lands or nothing.
    this.recordTx = this.db.transaction((match) => {
      const info = this.stmt.insertMatch.run({
        played_at: match.playedAt,
        table_id: match.tableId,
        end_reason: match.endReason,
        rated: match.rated ? 1 : 0,
        winner_team: match.winnerTeam,
        score_a: match.score[0],
        score_b: match.score[1],
        rounds: match.rounds,
        redeals: match.redeals,
        lineup_key: match.lineupKey,
        note: match.note || '',
        summary_json: JSON.stringify(match.summary),
      });
      const matchId = Number(info.lastInsertRowid);
      match.seats.forEach(s => this.stmt.insertSeat.run({
        match_id: matchId,
        seat: s.seat,
        team: s.team,
        player_key: s.key,
        name: s.name,
        is_bot: s.isBot ? 1 : 0,
        rated: s.rated ? 1 : 0,
        rating_before: s.ratingBefore,
        rating_after: s.ratingAfter,
        delta: s.delta,
        grade: s.grade,
        grade_score: s.gradeScore,
        tricks: s.tricks,
        calls: s.calls,
        calls_made: s.callsMade,
      }));
      match.players.forEach(p => {
        if (p.isNew) this.stmt.insertPlayer.run(p.row);
        else this.stmt.updatePlayer.run(p.row);
      });
      return matchId;
    });
  }

  getPlayer(key) {
    return this.stmt.getPlayer.get(key) || null;
  }

  recordMatch(match) {
    return this.recordTx(match);
  }

  topPlayers(limit) {
    return this.stmt.topPlayers.all(limit);
  }

  loadMatch(id) {
    const m = this.stmt.getMatch.get(id);
    if (!m) return null;
    return Object.assign({}, m, { seats: this.stmt.getSeats.all(id) });
  }

  playerMatches(key, limit) {
    return this.stmt.playerMatchIds.all(key, limit).map(r => this.loadMatch(r.match_id)).filter(Boolean);
  }

  recentMatches(limit) {
    return this.stmt.recentMatchIds.all(limit).map(r => this.loadMatch(r.id)).filter(Boolean);
  }

  getMatch(id) {
    return this.loadMatch(id);
  }

  countLineupSince(lineupKey, sinceIso) {
    return this.stmt.countLineup.get(lineupKey, sinceIso).n;
  }

  counts() {
    return this.stmt.counts.get();
  }

  close() {
    try { this.db.close(); } catch (e) { /* ignore */ }
  }
}

module.exports = SqliteStore;
