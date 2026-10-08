// Portable JSON-file leaderboard store. Used when a native SQLite build is
// not available (for example inside the packaged single-file executable).
// Same interface and the same row shapes as the SQLite store, so nothing
// above the database layer needs to know which one is in use. Writes are
// atomic (temp file + rename), and match history is capped so the file
// cannot grow without bound.
const fs = require('fs');

const MAX_MATCHES = 2000;

class JsonStore {
  constructor(file) {
    this.file = file;
    this.data = { version: 2, nextId: 1, players: {}, matches: [] };
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (parsed && parsed.version === 2 && parsed.players && Array.isArray(parsed.matches)) {
        this.data = parsed;
      }
    } catch (e) { /* no file yet, start empty */ }
  }

  save() {
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data));
    fs.renameSync(tmp, this.file);
  }

  getPlayer(key) {
    const row = this.data.players[key];
    return row ? Object.assign({}, row) : null;
  }

  recordMatch(match) {
    const id = this.data.nextId++;
    this.data.matches.push({
      id,
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
      seats: match.seats.map(s => ({
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
      })),
    });
    if (this.data.matches.length > MAX_MATCHES) {
      this.data.matches.splice(0, this.data.matches.length - MAX_MATCHES);
    }
    match.players.forEach(p => {
      const existing = this.data.players[p.row.key];
      this.data.players[p.row.key] = existing
        ? Object.assign(existing, p.row, { claim_hash: existing.claim_hash, created_at: existing.created_at })
        : Object.assign({}, p.row);
    });
    this.save();
    return id;
  }

  topPlayers(limit) {
    return Object.values(this.data.players)
      .filter(p => p.games > 0)
      .sort((a, b) => b.rating - a.rating || b.games - a.games || String(a.name).localeCompare(String(b.name)))
      .slice(0, limit)
      .map(p => Object.assign({}, p));
  }

  copyMatch(m) {
    return Object.assign({}, m, { seats: m.seats.map(s => Object.assign({}, s)) });
  }

  playerMatches(key, limit) {
    const out = [];
    for (let i = this.data.matches.length - 1; i >= 0 && out.length < limit; i--) {
      const m = this.data.matches[i];
      if (m.seats.some(s => s.player_key === key)) out.push(this.copyMatch(m));
    }
    return out;
  }

  recentMatches(limit) {
    return this.data.matches.slice(-limit).reverse().map(m => this.copyMatch(m));
  }

  getMatch(id) {
    const m = this.data.matches.find(x => x.id === id);
    return m ? this.copyMatch(m) : null;
  }

  countLineupSince(lineupKey, sinceIso) {
    return this.data.matches.filter(m =>
      m.lineup_key === lineupKey && m.rated && m.played_at >= sinceIso).length;
  }

  counts() {
    return {
      players: Object.values(this.data.players).filter(p => p.games > 0).length,
      matches: this.data.matches.length,
    };
  }

  close() { /* nothing to close */ }
}

module.exports = JsonStore;
