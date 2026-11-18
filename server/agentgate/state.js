// Persisted gate state under <project>/.shipproof/state/ (git-ignored by `shipproof init`).
// Per session: the baseline snapshot taken when the user's turn began, the number of blocked completions in
// that turn, and the last decision. Project-wide: the verification cache, keyed so that reuse is only possible
// when the criterion's source scope, target URL and Kane engine are all unchanged.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const dirOf = (cwd) => path.join(cwd, '.shipproof', 'state');

export function sessionKey(sessionId) {
  const s = String(sessionId || '');
  return /^[A-Za-z0-9_-]{1,100}$/.test(s) ? s : crypto.createHash('sha256').update(s || 'anonymous').digest('hex').slice(0, 32);
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file); // atomic replace on POSIX and Windows (NTFS)
}

export function loadSession(cwd, sessionId) {
  return readJson(path.join(dirOf(cwd), `session-${sessionKey(sessionId)}.json`), null);
}

export function saveSession(cwd, sessionId, state) {
  writeJsonAtomic(path.join(dirOf(cwd), `session-${sessionKey(sessionId)}.json`), state);
}

export function loadCache(cwd) {
  return readJson(path.join(dirOf(cwd), 'verification-cache.json'), {});
}

export function saveCache(cwd, cache) {
  writeJsonAtomic(path.join(dirOf(cwd), 'verification-cache.json'), cache);
}

export const runsRootOf = (cwd) => path.join(cwd, '.shipproof', 'runs');
export const stateDirOf = dirOf;
