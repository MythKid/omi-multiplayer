// Name claims. There are no accounts, so a ranked name is tied to a random
// secret kept in the browser that first played a ranked match with it. Only a
// SHA-256 hash of the secret is stored, and it is compared in constant time.
// Anyone can still sit down under any name; they just are not ranked under a
// name another browser has claimed, so nobody can tank someone else's rating.
const crypto = require('crypto');

const SECRET_PATTERN = /^[A-Za-z0-9_-]{32}$/; // 24 random bytes, base64url

function newSecret() {
  return crypto.randomBytes(24).toString('base64url');
}

function isWellFormed(secret) {
  return typeof secret === 'string' && SECRET_PATTERN.test(secret);
}

function hashSecret(secret) {
  return crypto.createHash('sha256').update(String(secret)).digest('hex');
}

function verify(secret, storedHash) {
  if (!isWellFormed(secret) || typeof storedHash !== 'string' || !/^[0-9a-f]{64}$/.test(storedHash)) {
    return false;
  }
  const a = Buffer.from(hashSecret(secret), 'hex');
  const b = Buffer.from(storedHash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = { newSecret, isWellFormed, hashSecret, verify };
