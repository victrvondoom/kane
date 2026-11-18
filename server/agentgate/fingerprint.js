// Deterministic content fingerprints of a project tree.
// Used to decide (a) whether application code changed since the agent's baseline, (b) whether a protected
// specification file was modified, and (c) whether a cached Kane result still describes the current code.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { normalizeRel, matchesAny, isProtected } from './spec.js';

const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_FILES = 50000;
// Directories that never hold application source, or that hold runtime output we must not hash.
const SKIP_NAMES = new Set(['node_modules', '.git', '.venv', '__pycache__', '.testmuai', 'dist', 'coverage', '.next', 'target']);
const SKIP_PREFIXES = ['.shipproof/runs/', '.shipproof/state/', '.tenantseal/runs/', '.tenantseal/scans/', '.tenantseal/state/', 'data/'];

function skipped(rel, name) {
  if (SKIP_NAMES.has(name)) return true;
  return SKIP_PREFIXES.some((p) => rel === p.slice(0, -1) || rel.startsWith(p));
}

/** Map of relative path -> sha256 of the file contents, for every regular file under root (deterministic order). */
export function scanTree(root) {
  const out = new Map();
  const walk = (dir, relDir) => {
    if (out.size >= MAX_FILES) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const ent of entries) {
      const rel = relDir ? `${relDir}/${ent.name}` : ent.name;
      if (skipped(rel, ent.name)) continue;
      const abs = path.join(dir, ent.name);
      if (ent.isSymbolicLink()) continue;
      if (ent.isDirectory()) walk(abs, rel);
      else if (ent.isFile()) {
        let st;
        try { st = fs.statSync(abs); } catch { continue; }
        if (st.size > MAX_FILE_BYTES) { out.set(rel, `oversize:${st.size}`); continue; }
        const h = crypto.createHash('sha256');
        h.update(fs.readFileSync(abs));
        out.set(rel, h.digest('hex'));
      }
    }
  };
  walk(root, '');
  return out;
}

/** Split a tree map into protected (specification/configuration) and application source entries. */
export function partition(tree, spec) {
  const protectedMap = new Map(), sourceMap = new Map();
  for (const [rel, hash] of tree) (isProtected(rel, spec) ? protectedMap : sourceMap).set(rel, hash);
  return { protectedMap, sourceMap };
}

export function diffMaps(before, after) {
  const added = [], removed = [], changed = [];
  for (const [k, v] of after) {
    if (!before.has(k)) added.push(k);
    else if (before.get(k) !== v) changed.push(k);
  }
  for (const k of before.keys()) if (!after.has(k)) removed.push(k);
  return { added: added.sort(), removed: removed.sort(), changed: changed.sort() };
}

export const diffIsEmpty = (d) => !d.added.length && !d.removed.length && !d.changed.length;
export const diffPaths = (d) => [...d.added, ...d.removed, ...d.changed].sort();

/** Fingerprint of only the files matching globs (or of everything when globs is empty). */
export function scopeFingerprint(sourceMap, globs) {
  const h = crypto.createHash('sha256');
  const entries = [...sourceMap.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  for (const [rel, hash] of entries) {
    if (!globs.length || matchesAny(rel, globs)) h.update(`${normalizeRel(rel)}\0${hash}\n`);
  }
  return h.digest('hex');
}

export function fingerprintOf(map) {
  const h = crypto.createHash('sha256');
  for (const [rel, hash] of [...map.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) h.update(`${rel}\0${hash}\n`);
  return h.digest('hex');
}

/** Snapshot the project: protected entries, source entries and their combined fingerprint. */
export function snapshot(cwd, spec) {
  const tree = scanTree(cwd);
  const { protectedMap, sourceMap } = partition(tree, spec);
  return {
    takenAt: new Date().toISOString(),
    fileCount: tree.size,
    protectedFiles: Object.fromEntries(protectedMap),
    sourceFiles: Object.fromEntries(sourceMap),
    sourceFingerprint: fingerprintOf(sourceMap),
    protectedFingerprint: fingerprintOf(protectedMap),
  };
}

export function mapOf(obj) { return new Map(Object.entries(obj || {})); }
