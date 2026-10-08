// Cache-busting for the browser client.
//
// Browsers, the service worker and Cloudflare (which tells browsers to keep
// scripts for hours) can all hold on to an old copy of the game after a
// deploy. And because the build stamps every file with the same 1980 date,
// "has it changed?" checks based on date and size cannot be trusted.
//
// So every script and stylesheet the page loads gets a URL carrying a
// fingerprint of its contents (/js/app.js?v=3f9a1c2e4b5d): a deploy that
// changes a file changes its URL, and no cache anywhere can serve the old
// one. The page itself is never cached and carries a build id; a client
// presents it when it connects, and an open tab on an older build is told to
// reload.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const INDEX_FILE = path.join(PUBLIC_DIR, 'index.html');
// Local scripts and stylesheets referenced by the page, e.g. src="/js/app.js".
const ASSET_REF = /(<(?:script|link)\b[^>]*?\s(?:src|href)=")(\/(?:[\w-]+\/)?[\w.-]+\.(?:js|css))(")/g;

const sha = (data) => crypto.createHash('sha256').update(data).digest('hex');

// Content fingerprint of a file, recomputed only when its size or mtime
// changes (so edits are picked up in development without a restart).
const fileHashes = new Map(); // absolute path -> { key, hash }
function fileHash(file, stat) {
  const st = stat || fs.statSync(file);
  const key = `${st.size}:${st.mtimeMs}`;
  const hit = fileHashes.get(file);
  if (hit && hit.key === key) return hit.hash;
  const hash = sha(fs.readFileSync(file)).slice(0, 12);
  fileHashes.set(file, { key, hash });
  return hash;
}

let source = null; // { hash, text, refs }
let page = null;   // { key, html, etag, build }

// The page as served: asset URLs fingerprinted, build id in a meta tag.
function indexPage() {
  const indexHash = fileHash(INDEX_FILE);
  if (!source || source.hash !== indexHash) {
    const text = fs.readFileSync(INDEX_FILE, 'utf8');
    const refs = [];
    text.replace(ASSET_REF, (m, pre, url) => { refs.push(url); return m; });
    source = { hash: indexHash, text, refs };
  }
  const versions = {};
  source.refs.forEach((url) => {
    try { versions[url] = fileHash(path.join(PUBLIC_DIR, url)); } catch (e) { /* missing file: leave as is */ }
  });
  const key = indexHash + JSON.stringify(versions);
  if (page && page.key === key) return page;

  const build = sha(key).slice(0, 12);
  const html = source.text
    .replace(ASSET_REF, (m, pre, url, post) => (versions[url] ? `${pre}${url}?v=${versions[url]}${post}` : m))
    .replace(/<head>/i, `<head>\n<meta name="omi-build" content="${build}">`);
  page = { key, html, etag: `"${sha(html).slice(0, 16)}"`, build };
  return page;
}

function currentBuild() {
  return indexPage().build;
}

module.exports = { PUBLIC_DIR, fileHash, indexPage, currentBuild };
