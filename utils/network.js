// Network helpers: working out the address to advertise on a LAN, and the
// host/origin checks that keep the server safe both on a private network and
// behind a public proxy.
const os = require('os');
const dgram = require('dgram');
const config = require('../config');

const PRIVATE_HOST = new RegExp(
  '^(localhost|127\\.\\d+\\.\\d+\\.\\d+|\\[::1\\]|10\\.\\d+\\.\\d+\\.\\d+|' +
  '192\\.168\\.\\d+\\.\\d+|172\\.(1[6-9]|2\\d|3[01])\\.\\d+\\.\\d+|' +
  '169\\.254\\.\\d+\\.\\d+)$'
);

function isPrivateIPv4(ip) {
  return /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip);
}

// Score each interface so we prefer the real Wi-Fi/Ethernet adapter that
// phones on the same network can actually reach, and push virtual adapters
// (VirtualBox, VMware, Hyper-V, WSL, Docker, VPNs) to the bottom.
function scoreInterface(name, ip) {
  const n = name.toLowerCase();
  let s = 0;
  if (/^192\.168\./.test(ip)) s += 20;
  else if (/^10\./.test(ip)) s += 16;
  else if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) s += 8;
  if (/^192\.168\.56\./.test(ip)) s -= 40;              // VirtualBox host-only default
  if (/wi-?fi|wlan|wireless/.test(n)) s += 12;
  else if (/ethernet|eth\d|en\d|^lan/.test(n)) s += 10;
  if (/virtualbox|vmware|hyper-v|vethernet|wsl|docker|tailscale|zerotier|\btap\b|\btun\b|bluetooth|loopback|npcap/.test(n)) {
    s -= 50;
  }
  return s;
}

function enumerateLocalIP() {
  const interfaces = os.networkInterfaces();
  const candidates = [];
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] || []) {
      const isV4 = iface.family === 'IPv4' || iface.family === 4;
      if (!isV4 || iface.internal) continue;
      if (/^169\.254\./.test(iface.address)) continue;  // APIPA link-local, not reachable
      candidates.push({ name, ip: iface.address, score: scoreInterface(name, iface.address) });
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  return candidates.length ? candidates[0].ip : '127.0.0.1';
}

// Ask the OS which source address it would use to reach an outside host. A
// UDP "connect" sends no packet, it just runs the routing table, so this
// returns the interface holding the default route. Works offline too.
function detectOutboundIP() {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ip) => { if (!settled) { settled = true; resolve(ip); } };
    let sock;
    try {
      sock = dgram.createSocket('udp4');
      sock.once('error', () => { try { sock.close(); } catch (e) {} finish(null); });
      sock.connect(53, '8.8.8.8', () => {
        let ip = null;
        try { ip = sock.address().address; } catch (e) { ip = null; }
        try { sock.close(); } catch (e) {}
        finish(ip);
      });
    } catch (e) {
      finish(null);
    }
    setTimeout(() => { try { if (sock) sock.close(); } catch (e) {} finish(null); }, 500);
  });
}

let detectedIP = null; // resolved once at startup, cached for the session

async function resolveLocalIP() {
  const ip = await detectOutboundIP();
  detectedIP = (ip && isPrivateIPv4(ip)) ? ip : enumerateLocalIP();
  return detectedIP;
}

function getLocalIP() {
  return detectedIP || enumerateLocalIP();
}

// The address to advertise for joining. In production a PUBLIC_URL is used;
// on a LAN the reachable local address is detected.
function getJoinURL() {
  if (config.publicUrl) return config.publicUrl;
  return `http://${getLocalIP()}:${config.port}`;
}

// Some networks let devices resolve "hostname.local" over mDNS. Only offer
// it when the hostname is valid for mDNS, since a dead link is worse than
// no link.
function getJoinHost() {
  const h = String(os.hostname() || '').split('.')[0].trim().toLowerCase();
  return /^[a-z0-9-]+$/.test(h) ? h + '.local' : '';
}

// Where a player should send friends, as { base, lan }. PUBLIC_URL wins.
// Otherwise, a visitor who reached us by a public hostname (deployed behind a
// proxy without PUBLIC_URL) shares that same address; on a LAN or localhost
// the detected Wi-Fi address is shared instead, since "localhost" on the
// host's machine means nothing to anyone else.
function inviteBase(headers) {
  if (config.publicUrl) return { base: config.publicUrl, lan: false };
  const h = headers || {};
  const host = String(h.host || '').trim().toLowerCase();
  const bare = host.replace(/:\d+$/, '');
  const looksPublic = /^[a-z0-9.-]+(:\d+)?$/.test(host) && /[a-z]/.test(bare) &&
    !PRIVATE_HOST.test(bare) && !bare.endsWith('.local') && bare.includes('.');
  if (looksPublic) {
    const fwd = String(h['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
    const proto = fwd === 'https' || fwd === 'http' ? fwd : (config.isProduction ? 'https' : 'http');
    return { base: `${proto}://${host}`, lan: false };
  }
  return { base: getJoinURL(), lan: true };
}

// Answer only for hostnames we trust. On a LAN this blocks DNS-rebinding by
// permitting private addresses (and this machine's own .local name, which the
// lobby offers as an alternative link) only. In production it honours
// ALLOWED_HOSTS, or trusts the proxy when none is configured.
function hostAllowed(hostHeader) {
  if (!hostHeader) return false;
  const host = String(hostHeader).replace(/:\d+$/, '').toLowerCase();
  if (config.allowedHosts.length) return config.allowedHosts.includes(host);
  if (config.isProduction) return true; // behind a trusted proxy, host is the public domain
  const mdns = getJoinHost();
  return PRIVATE_HOST.test(host) || (mdns !== '' && host === mdns);
}

// Reject cross-site WebSocket/handshake attempts: the Origin, if present,
// must match the Host the request was addressed to.
function originAllowed(origin, hostHeader) {
  if (!origin) return true; // same-origin fetches and non-browser clients
  try {
    return new URL(origin).host.toLowerCase() === String(hostHeader || '').toLowerCase();
  } catch (e) {
    return false;
  }
}

module.exports = {
  isPrivateIPv4,
  enumerateLocalIP,
  detectOutboundIP,
  resolveLocalIP,
  getLocalIP,
  getJoinURL,
  getJoinHost,
  inviteBase,
  hostAllowed,
  originAllowed,
};
