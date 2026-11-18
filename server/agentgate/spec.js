// Acceptance specification for the agent completion gate: .shipproof/criteria.json
// The file is the single place where acceptance criteria are defined for a local/CI project.
// It is itself protected: a coding agent may not edit it to make a failing criterion disappear.
import fs from 'node:fs';
import path from 'node:path';

export const SPEC_RELATIVE = path.join('.shipproof', 'criteria.json');

// Always protected, whether or not the spec lists extra patterns.
// TenantSeal's trusted definitions: its configuration and its scanner code. Run output is excluded from fingerprints.
export const DEFAULT_PROTECTED = ['.shipproof/**', '.claude/**', '.github/**', '.tenantseal/config.json', 'server/tenantseal/**'];

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function normalizeRel(p) {
  return String(p).replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
}

/** Minimal glob matcher: `**` crosses directories, `*` does not, `?` is one non-separator char. */
export function globToRegExp(glob) {
  const g = normalizeRel(glob);
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') {
        const slashAfter = g[i + 2] === '/';
        re += slashAfter ? '(?:.*/)?' : '.*';
        i += slashAfter ? 2 : 1;
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

export function matchesAny(relPath, globs) {
  const p = normalizeRel(relPath);
  return globs.some((g) => globToRegExp(g).test(p));
}

export function protectedGlobs(spec) {
  return [...DEFAULT_PROTECTED, ...((spec && spec.protected) || [])];
}

export function isProtected(relPath, spec = null) {
  return matchesAny(relPath, protectedGlobs(spec));
}

/** Thrown for any spec the gate cannot trust. The message says exactly what to fix. */
export class SpecError extends Error {
  constructor(message) { super(message); this.name = 'SpecError'; this.code = 'spec_invalid'; }
}

export function validateSpec(raw) {
  const fail = (m) => { throw new SpecError(m); };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('criteria.json must be a JSON object');
  if (raw.version !== 1) fail('criteria.json "version" must be 1');
  const app = raw.app;
  if (!app || typeof app !== 'object') fail('"app" is required');
  let url;
  try { url = new URL(String(app.url || '')); } catch { fail('"app.url" must be an absolute http(s) URL'); }
  if (!/^https?:$/.test(url.protocol)) fail('"app.url" must use http or https');
  const context = app.context == null ? '' : String(app.context);
  if (context.length > 2000) fail('"app.context" must be at most 2000 characters');
  const protectedExtra = raw.protected == null ? [] : raw.protected;
  if (!Array.isArray(protectedExtra) || protectedExtra.some((p) => typeof p !== 'string' || !p.trim())) fail('"protected" must be an array of path patterns');
  if (!Array.isArray(raw.criteria) || raw.criteria.length === 0) fail('"criteria" must be a non-empty array');
  if (raw.criteria.length > 200) fail('at most 200 criteria are supported per spec');
  const seen = new Set();
  const criteria = raw.criteria.map((c, i) => {
    const where = `criteria[${i}]`;
    if (!c || typeof c !== 'object') fail(`${where} must be an object`);
    if (typeof c.id !== 'string' || !ID_RE.test(c.id)) fail(`${where}.id must match ${ID_RE}`);
    if (seen.has(c.id)) fail(`duplicate criterion id "${c.id}"`);
    seen.add(c.id);
    const text = String(c.text || '').trim();
    if (text.length < 5 || text.length > 1000) fail(`${where}.text must be 5-1000 characters`);
    const paths = c.paths == null ? [] : c.paths;
    if (!Array.isArray(paths) || paths.length > 50 || paths.some((p) => typeof p !== 'string' || !p.trim())) fail(`${where}.paths must be an array of up to 50 path patterns`);
    return { id: c.id, text, paths: paths.map(normalizeRel) };
  });
  return {
    version: 1,
    app: { url: url.href, context: context.trim() },
    protected: protectedExtra.map(normalizeRel),
    criteria,
  };
}

/** Load the spec for a project directory. Returns null when none exists; throws SpecError when invalid. */
export function loadSpec(cwd) {
  const file = path.join(cwd, SPEC_RELATIVE);
  if (!fs.existsSync(file)) return null;
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { throw new SpecError(`criteria.json is not valid JSON: ${e.message}`); }
  return validateSpec(raw);
}

export const TEMPLATE = {
  version: 1,
  app: { url: 'http://127.0.0.1:4100/', context: 'Use the application as a logged-in customer would.' },
  protected: [],
  criteria: [
    { id: 'AC-001', text: 'Replace with a real acceptance criterion, for example: the checkout total shows the discounted amount.', paths: ['src/**'] },
  ],
};
