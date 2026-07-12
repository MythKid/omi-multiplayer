// Leaderboard tests: team-name generation, dedupe-to-highest, sorting,
// input validation, and persistence across a store reload. Uses an isolated
// temporary data directory so it never touches real data.
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = path.join(os.tmpdir(), 'omi-lb-test-' + Date.now());
process.env.DATA_DIR = TMP;      // isolate storage (read before config loads)
process.env.LOG_LEVEL = 'error'; // keep the output clean

const lb = require('./services/leaderboardService');
const db = require('./database');

let failures = 0;
function assert(cond, msg) { if (!cond) { failures++; console.log('  FAIL: ' + msg); } }

console.log('leaderboard tests\n');

// ---- team name generation ----
assert(lb.makeTeamName('John', 'Sarah') === 'John + Sarah', 'team name is "A + B"');
assert(lb.makeTeamName('', '') === 'Player + Player', 'blank names fall back to Player');
assert(lb.makeTeamName('  Al ce ', 'Bob') === 'Al ce + Bob', 'names are trimmed/collapsed');
console.log('  team names ok');

// ---- submit, dedupe to highest, sort, rank ----
lb.submitTeamResult('Alice', 'Bob', 90);
lb.submitTeamResult('Alice', 'Bob', 120);  // higher: replaces
lb.submitTeamResult('Alice', 'Bob', 50);   // lower: ignored
lb.submitTeamResult('Mike', 'Emma', 181);
lb.submitTeamResult('John', 'Sarah', 197);

let top = lb.getTopScores(10);
assert(top.length === 3, 'three unique teams after dedupe (got ' + top.length + ')');
assert((top.find(t => t.team === 'Alice + Bob') || {}).score === 120, 'keeps the highest score (120)');
assert(top[0].team === 'John + Sarah' && top[0].rank === 1, 'top team ranked first');
assert(top.every((r, i) => i === 0 || top[i - 1].score >= r.score), 'sorted highest first');
assert(top[0].rank === 1 && top[1].rank === 2 && top[2].rank === 3, 'ranks are 1..n');
console.log('  submit / dedupe / sort / rank ok');

// ---- validation ----
assert(lb.submitTeamResult('X', 'Y', 0) === null, 'zero score rejected');
assert(lb.submitTeamResult('X', 'Y', -5) === null, 'negative score rejected');
assert(lb.submitTeamResult('X', 'Y', 'abc') === null, 'non-numeric score rejected');
assert(lb.submitTeamResult('X', 'Y', Infinity) === null, 'infinite score rejected');
assert(lb.getTopScores(10).length === 3, 'rejected scores are not stored');
console.log('  input validation ok');

// ---- limit ----
assert(lb.getTopScores(2).length === 2, 'limit caps the number of rows');
console.log('  limit ok');

// ---- persistence across a store reload (simulates a restart) ----
db.closeStore();               // drop the open handle
const reloaded = lb.getTopScores(10); // getStore() reopens from disk
assert(reloaded.length === 3, 'data survives a store reload');
assert((reloaded.find(t => t.team === 'Alice + Bob') || {}).score === 120, 'reloaded score intact');
console.log('  persistence ok');

// cleanup
try { db.closeStore(); } catch (e) {}
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}

console.log(failures === 0 ? '\nLEADERBOARD TESTS PASSED' : '\n' + failures + ' FAILURES');
process.exit(failures === 0 ? 0 : 1);
