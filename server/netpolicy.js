// Target URL policy (SSRF guard). Kane CLI drives a browser from this server, so a registered
// URL is a request the server makes on a user's behalf.
import dns from 'node:dns/promises';
import net from 'node:net';

function v4Class(ip) {
  const [a, b] = ip.split('.').map(Number);
  if (a === 169 && b === 254) return 'link-local';           // cloud metadata lives here — never allowed
  if (a === 0) return 'unspecified';
  if (a === 127) return 'loopback';
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)) return 'private';
  if (a >= 224) return 'reserved';
  return 'public';
}
export function addressClass(ip) {
  if (net.isIPv4(ip)) return v4Class(ip);
  const x = ip.toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(x);
  if (mapped) return v4Class(mapped[1]);
  if (x === '::1') return 'loopback';
  if (x === '::') return 'unspecified';
  if (/^fe[89ab]/.test(x)) return 'link-local';
  if (/^f[cd]/.test(x)) return 'private';
  if (/^ff/.test(x)) return 'reserved';
  return 'public';
}

/** Returns { ok, url, reason }. Never throws. */
export async function checkTarget(input, { allowPrivate = false, lookup = dns.lookup } = {}) {
  let u;
  try { u = new URL(String(input).trim()); } catch { return { ok: false, reason: 'Application URL is not a valid URL' }; }
  if (!/^https?:$/.test(u.protocol)) return { ok: false, reason: 'Application URL must start with http:// or https://' };
  if (u.username || u.password) return { ok: false, reason: 'Application URL must not contain credentials' };
  const host = u.hostname.replace(/^\[|\]$/g, '');
  let addrs;
  if (net.isIP(host)) addrs = [host];
  else {
    try { addrs = (await lookup(host, { all: true })).map((a) => a.address); }
    catch { return { ok: false, reason: `Application URL host "${host}" does not resolve from the verification server` }; }
  }
  for (const a of addrs) {
    const c = addressClass(a);
    if (c === 'link-local' || c === 'unspecified' || c === 'reserved')
      return { ok: false, reason: `Application URL resolves to a ${c} address (${a}), which is never allowed` };
    if ((c === 'loopback' || c === 'private') && !allowPrivate)
      return { ok: false, reason: `Application URL resolves to a ${c} address (${a}). Private targets are disabled on this server (ALLOW_PRIVATE_TARGETS=1 enables them).` };
  }
  return { ok: true, url: u.toString() };
}
