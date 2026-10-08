// Table chat: message cleaning, a bounded history per table, and a per-player
// rate limit. Chat is public table talk: every message goes to everyone at
// the table (there is no private or team channel, so it cannot carry secret
// signals between partners), and nothing is written to disk or to the logs.
const { stripUnsafe } = require('../utils/sanitize');

const MAX_LENGTH = 200;   // characters (code points) per message
const HISTORY_SIZE = 50;  // messages kept per table for late joiners
const BURST = 4;          // messages allowed back to back
const REFILL_MS = 2000;   // then one more every two seconds
const REPEAT_MS = 10000;  // the same text again this soon is dropped

// Strip control, zero-width and bidi characters, collapse whitespace, and
// clamp the length without splitting a surrogate pair. '' means "drop it".
function sanitizeMessage(text) {
  if (typeof text !== 'string') return '';
  // Whitespace (newlines included) becomes a space first, so stripping the
  // control characters afterwards never glues two words together.
  const cleaned = stripUnsafe(text.slice(0, MAX_LENGTH * 4).replace(/\s+/g, ' '))
    .replace(/ {2,}/g, ' ')
    .trim();
  return Array.from(cleaned).slice(0, MAX_LENGTH).join('');
}

class ChatLog {
  constructor(limit) {
    this.limit = limit || HISTORY_SIZE;
    this.items = [];
    this.nextId = 1;
  }

  add(message) {
    const entry = Object.assign({ id: this.nextId++, ts: Date.now() }, message);
    this.items.push(entry);
    if (this.items.length > this.limit) this.items.shift();
    return entry;
  }

  list() {
    return this.items.slice();
  }

  clear() {
    this.items = [];
  }
}

// One limiter per seated player (it lives on the player record, so a
// reconnect does not reset it). Returns 'ok', 'rate' or 'repeat'.
function makeChatLimiter(now) {
  const clock = now || Date.now;
  let tokens = BURST;
  let last = clock();
  let lastText = '';
  let lastAt = -Infinity;
  return function allow(text) {
    const t = clock();
    tokens = Math.min(BURST, tokens + (t - last) / REFILL_MS);
    last = t;
    if (text.toLowerCase() === lastText && t - lastAt < REPEAT_MS) return 'repeat';
    if (tokens < 1) return 'rate';
    tokens -= 1;
    lastText = text.toLowerCase();
    lastAt = t;
    return 'ok';
  };
}

module.exports = { MAX_LENGTH, HISTORY_SIZE, sanitizeMessage, ChatLog, makeChatLimiter };
