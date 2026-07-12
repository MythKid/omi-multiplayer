// Portable JSON-file leaderboard store. Used when a native SQLite build is
// not available (for example inside the packaged single-file executable).
// Same interface as the SQLite store, so nothing above the database layer
// needs to know which one is in use. Writes are atomic (temp file + rename).
const fs = require('fs');

class JsonStore {
  constructor(file) {
    this.file = file;
    this.rows = [];
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Array.isArray(parsed)) this.rows = parsed;
    } catch (e) { /* no file yet, start empty */ }
  }

  save() {
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.rows));
    fs.renameSync(tmp, this.file);
  }

  submit(team, score, date) {
    const existing = this.rows.find(r => r.team === team);
    if (existing) {
      if (score > existing.score) { existing.score = score; existing.date = date; this.save(); }
    } else {
      this.rows.push({ team, score, date });
      this.save();
    }
  }

  top(limit) {
    return this.rows.slice()
      .sort((a, b) => b.score - a.score || String(a.date).localeCompare(String(b.date)))
      .slice(0, limit);
  }

  close() { /* nothing to close */ }
}

module.exports = JsonStore;
