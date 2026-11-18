// Network evidence: reads the HAR files that a Kane run wrote into its evidence pack, and discovers the
// same-origin routes that relate to a planted resource. Request headers are never kept (they carry cookies and
// authorisation); response bodies are kept only up to a size bound because the canary test needs them.
import fs from 'node:fs';
import path from 'node:path';

const MAX_FILES = 40;
const MAX_BYTES = 25 * 1024 * 1024;
const MAX_BODY = 262144;

/** Recursively collect *.har files under dir (bounded). Returns { entries, files, malformed }. */
export function readHarFiles(dir, { maxFiles = MAX_FILES, maxBytes = MAX_BYTES } = {}) {
  const files = [];
  const walk = (d, depth) => {
    if (depth > 6 || files.length >= maxFiles) return;
    let items;
    try { items = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const it of items) {
      const p = path.join(d, it.name);
      if (it.isSymbolicLink()) continue;
      if (it.isDirectory()) walk(p, depth + 1);
      else if (it.isFile() && /\.har$/i.test(it.name) && files.length < maxFiles) files.push(p);
    }
  };
  if (dir && fs.existsSync(dir)) walk(dir, 0);
  const entries = [];
  let malformed = 0, total = 0;
  for (const f of files) {
    let size = 0;
    try { size = fs.statSync(f).size; } catch { malformed++; continue; }
    total += size;
    if (total > maxBytes) { malformed++; break; }
    let har;
    try { har = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { malformed++; continue; }
    const list = har && har.log && Array.isArray(har.log.entries) ? har.log.entries : null;
    if (!list) { malformed++; continue; }
    for (const e of list) {
      const req = e && e.request, res = e && e.response;
      if (!req || typeof req.url !== 'string' || typeof req.method !== 'string') continue;
      const kind = /kind=(\w+)/.exec(e.comment || '')?.[1] || 'navigation';
      const loc = (res?.headers || []).find((h) => String(h.name).toLowerCase() === 'location')?.value || null;
      entries.push({
        file: path.relative(dir, f).replace(/\\/g, '/'),
        method: req.method.toUpperCase(),
        url: req.url,
        status: Number(res?.status) || 0,
        kind,
        location: loc,
        body: String(res?.content?.text || '').slice(0, MAX_BODY),
      });
    }
  }
  return { entries, files: files.length, malformed };
}

/** Normalise a URL to a same-origin path. Returns null for another origin or an invalid URL. */
export function sameOriginPath(url, origin) {
  let u;
  try { u = new URL(url, origin); } catch { return null; }
  if (u.origin !== origin) return null;
  return u.pathname;
}

/** Replace the resource id segment with :id, so routes for different records deduplicate. */
export function templateOf(pathname, resourceId) {
  return pathname.split('/').map((seg) => (seg === resourceId ? ':id' : seg)).join('/');
}

/** Concrete path for a template and resource id. */
export function concretePath(template, resourceId) {
  return template.replace(/:id/g, resourceId);
}

/**
 * Discover routes related to a planted resource from HAR entries.
 * A route is related when its path carries the resource id, or (for GET only) its response body carries the canary.
 * Non-GET requests are counted only when they carry the resource id. Entries for other origins are excluded.
 */
export function discoverRoutes({ entries, origin, resourceId, canary }) {
  const routes = new Map();
  let foreign = 0;
  for (const e of entries) {
    const p = sameOriginPath(e.url, origin);
    if (p === null) { foreign++; continue; }
    const withId = !!resourceId && p.split('/').includes(resourceId);
    const carriesCanary = e.method === 'GET' && !!canary && e.body.includes(canary);
    if (!withId && !carriesCanary) continue;
    if (!withId && e.method !== 'GET') continue;
    const template = withId ? templateOf(p, resourceId) : p;
    const key = `${e.method} ${template}`;
    const cur = routes.get(key) || { method: e.method, template, kind: e.kind, observations: 0, carriesCanary: false, sources: new Set() };
    cur.observations++;
    cur.carriesCanary = cur.carriesCanary || carriesCanary;
    cur.sources.add(e.file);
    // Prefer how the route was actually requested: background fetch, then navigation, then redirect.
    if (e.kind === 'background') cur.kind = 'background';
    else if (cur.kind === 'redirect' && e.kind !== 'redirect') cur.kind = e.kind;
    routes.set(key, cur);
  }
  return {
    routes: [...routes.values()].map((r) => ({ ...r, sources: [...r.sources].sort() })).sort((a, b) => ((a.template + a.method) < (b.template + b.method) ? -1 : 1)),
    foreignEntries: foreign,
  };
}

/** Entries for one concrete same-origin path and method (used to decide whether a probe observed a route). */
export function observedAt(entries, origin, pathname, method = 'GET') {
  return entries.filter((e) => e.method === method && sameOriginPath(e.url, origin) === pathname);
}
