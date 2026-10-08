// Join QR codes, made on demand and cached. A lobby shows a code for the
// address its players actually use (the public domain, or the LAN address),
// so codes are keyed by URL. The cache is small and bounded: a hostile Host
// header can only ever cycle it, never grow it.
const QRCode = require('qrcode');
const logger = require('./logger');

const MAX_ENTRIES = 64;
const ready = new Map();   // url -> data URL, oldest first
const pending = new Map(); // url -> Promise

const OPTIONS = {
  margin: 1, width: 320, errorCorrectionLevel: 'M',
  color: { dark: '#0d2b18ff', light: '#f4ecd0ff' },
};

// Build (or reuse) the code for `url`. Resolves to a data URL, or null.
function make(url) {
  if (ready.has(url)) return Promise.resolve(ready.get(url));
  if (pending.has(url)) return pending.get(url);
  const p = QRCode.toDataURL(url, OPTIONS)
    .then((data) => {
      ready.set(url, data);
      while (ready.size > MAX_ENTRIES) ready.delete(ready.keys().next().value);
      return data;
    })
    .catch((e) => {
      logger.warn('Could not build a join QR code:', e.message);
      return null;
    })
    .finally(() => pending.delete(url));
  pending.set(url, p);
  return p;
}

// The cached code for `url`, or null while it is still being drawn. When it
// had to be drawn, `onReady` runs once it exists (to refresh the lobby).
function get(url, onReady) {
  if (ready.has(url)) return ready.get(url);
  const wasPending = pending.has(url);
  const p = make(url);
  if (!wasPending && onReady) p.then((data) => { if (data) onReady(); });
  return null;
}

module.exports = { make, get };
