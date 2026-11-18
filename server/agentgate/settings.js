// Installs and removes SHIPPROOF's Claude Code hooks in a settings file.
// Only handlers whose command contains MARKER are ever added or removed; every other key and hook is preserved.
// The existing file is backed up before the first change, and the result is re-read and validated before success.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MARKER = 'shipproof.js" hook run ';
const PRE_MATCHER = 'Edit|Write|MultiEdit|NotebookEdit';
const DEFAULT_CLI = fileURLToPath(new URL('../../cli/shipproof.js', import.meta.url));

/** settings file for a scope: local (per user, git-ignored) by default, shared when asked. */
export function settingsPath(cwd, { shared = false } = {}) {
  return path.join(cwd, '.claude', shared ? 'settings.json' : 'settings.local.json');
}

const slash = (p) => p.replace(/\\/g, '/');

/** Command line Claude Code runs for an event. Forward slashes work in Git Bash, cmd and PowerShell. */
export function hookCommand(event, cliPath = DEFAULT_CLI) {
  return `"${slash(process.execPath)}" "${slash(cliPath)}" hook run ${event}`;
}

export function desiredHooks(cliPath = DEFAULT_CLI) {
  return {
    UserPromptSubmit: [{ hooks: [{ type: 'command', command: hookCommand('UserPromptSubmit', cliPath), timeout: 60 }] }],
    PreToolUse: [{ matcher: PRE_MATCHER, hooks: [{ type: 'command', command: hookCommand('PreToolUse', cliPath), timeout: 15 }] }],
    Stop: [{ hooks: [{ type: 'command', command: hookCommand('Stop', cliPath), timeout: 900 }] }],
  };
}

function readSettings(file) {
  if (!fs.existsSync(file)) return {};
  const raw = fs.readFileSync(file, 'utf8');
  if (!raw.trim()) return {};
  let parsed;
  try { parsed = JSON.parse(raw); } catch (e) { throw new Error(`${file} is not valid JSON (${e.message}). Fix or remove it, then run install again. Nothing was changed.`); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${file} must contain a JSON object. Nothing was changed.`);
  return parsed;
}

const isOurs = (h) => h && typeof h.command === 'string' && h.command.includes(MARKER);

/** Remove SHIPPROOF handlers from a settings object, keeping every other group and key. Returns a new object. */
export function stripOurs(settings) {
  const out = { ...settings };
  if (!out.hooks || typeof out.hooks !== 'object') return out;
  const hooks = {};
  for (const [event, groups] of Object.entries(out.hooks)) {
    if (!Array.isArray(groups)) { hooks[event] = groups; continue; }
    const kept = groups
      .map((g) => (g && Array.isArray(g.hooks) ? { ...g, hooks: g.hooks.filter((h) => !isOurs(h)) } : g))
      .filter((g) => !(g && Array.isArray(g.hooks) && g.hooks.length === 0 && Object.keys(g).every((k) => k === 'matcher' || k === 'hooks')));
    if (kept.length) hooks[event] = kept;
  }
  if (Object.keys(hooks).length) out.hooks = hooks; else delete out.hooks;
  return out;
}

/** Install hooks. Returns { file, backup, added: [events], changed: boolean }. */
export function installHooks(cwd, { shared = false, cliPath = DEFAULT_CLI, now = new Date() } = {}) {
  const file = settingsPath(cwd, { shared });
  const before = readSettings(file);
  const existed = fs.existsSync(file);
  const stripped = stripOurs(before);
  const desired = desiredHooks(cliPath);
  const hooks = { ...(stripped.hooks || {}) };
  for (const [event, groups] of Object.entries(desired)) hooks[event] = [...(hooks[event] || []), ...groups];
  const next = { ...stripped, hooks };
  const serialised = JSON.stringify(next, null, 2) + '\n';
  const previous = existed ? fs.readFileSync(file, 'utf8') : null;
  if (previous === serialised) return { file, backup: null, added: Object.keys(desired), changed: false };

  fs.mkdirSync(path.dirname(file), { recursive: true });
  let backup = null;
  if (existed) {
    backup = `${file}.shipproof-backup-${now.toISOString().replace(/[:.]/g, '-')}`;
    fs.copyFileSync(file, backup);
  }
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, serialised);
  fs.renameSync(tmp, file);
  // Validate what is now on disk before reporting success.
  const check = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const event of Object.keys(desired)) {
    if (!check.hooks?.[event]?.some((g) => g.hooks?.some(isOurs))) throw new Error(`verification failed: ${event} hook missing after install`);
  }
  return { file, backup, added: Object.keys(desired), changed: true };
}

/** Remove SHIPPROOF hooks. Other settings are kept. Returns { file, removed: number }. */
export function uninstallHooks(cwd, { shared = false } = {}) {
  const file = settingsPath(cwd, { shared });
  if (!fs.existsSync(file)) return { file, removed: 0 };
  const before = readSettings(file);
  const count = (s) => Object.values(s.hooks || {}).flat().reduce((n, g) => n + ((g && g.hooks) || []).filter(isOurs).length, 0);
  const removed = count(before);
  if (removed === 0) return { file, removed: 0 };
  const next = stripOurs(before);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n');
  fs.renameSync(tmp, file);
  return { file, removed };
}

/** What is installed right now, per settings scope. */
export function hookStatus(cwd) {
  const out = {};
  for (const shared of [false, true]) {
    const file = settingsPath(cwd, { shared });
    let present;
    try {
      const s = readSettings(file);
      present = Object.fromEntries(Object.keys(desiredHooks()).map((e) => [e, (s.hooks?.[e] || []).some((g) => (g.hooks || []).some(isOurs))]));
    } catch (e) { present = { error: e.message }; }
    out[shared ? 'shared' : 'local'] = { file, installed: present };
  }
  return out;
}
