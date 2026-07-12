// Shared name sanitization. Removes control, zero-width and bidi-override
// characters (the Trojan Source class), collapses whitespace, and clamps the
// length. Used for both player names and leaderboard team names so the rule
// lives in one place. Ranges are matched by code point to keep this source
// free of the very characters it strips.
const UNSAFE_RANGES = [
  [0x00, 0x1f],     // C0 control characters
  [0x7f, 0x9f],     // DEL and C1 control characters
  [0x200b, 0x200f], // zero-width spaces and directional marks
  [0x2028, 0x202e], // line/paragraph separators and bidi overrides
  [0x2066, 0x2069], // bidi isolates
];

function stripUnsafe(str) {
  let out = '';
  for (const ch of str) {
    const code = ch.codePointAt(0);
    if (!UNSAFE_RANGES.some(([a, b]) => code >= a && code <= b)) out += ch;
  }
  return out;
}

function sanitizeName(name, maxLength) {
  return stripUnsafe(String(name || ''))
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength || 32);
}

module.exports = { sanitizeName };
