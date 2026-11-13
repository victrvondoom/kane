// SQLite persistence (built-in node:sqlite) with file-based migrations.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function openDb(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, 'shipproof.db'));
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;');
  migrate(db);
  return {
    raw: db,
    get: (sql, ...p) => db.prepare(sql).get(...p),
    all: (sql, ...p) => db.prepare(sql).all(...p),
    run: (sql, ...p) => db.prepare(sql).run(...p),
    tx(fn) {
      db.exec('BEGIN');
      try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
    },
    /** Consistent online backup (safe while the server is running). */
    backup(file) { db.exec(`VACUUM INTO '${String(file).replace(/'/g, "''")}'`); return file; },
    close: () => db.close(),
  };
}

export function migrate(db) {
  db.exec('CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
  const dir = path.join(ROOT, 'migrations');
  const done = new Set(db.prepare('SELECT name FROM _migrations').all().map((r) => r.name));
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    if (done.has(f)) continue;
    db.exec('BEGIN');
    try {
      db.exec(fs.readFileSync(path.join(dir, f), 'utf8'));
      DATA_STEPS[f]?.(db);
      db.prepare('INSERT INTO _migrations VALUES (?, ?)').run(f, new Date().toISOString());
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  }
}

// Data steps that SQL alone cannot express; they run inside the same transaction as their migration.
const DATA_STEPS = {
  '002_hardening.sql'(db) {
    const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');
    for (const p of db.prepare('SELECT id, share_token FROM projects WHERE share_token IS NOT NULL').all())
      db.prepare('UPDATE projects SET share_token_hash = ?, share_created_at = ?, share_token = NULL WHERE id = ?').run(sha(p.share_token), new Date().toISOString(), p.id);
    for (const e of db.prepare('SELECT id FROM evidence WHERE uid IS NULL').all())
      db.prepare('UPDATE evidence SET uid = ? WHERE id = ?').run(crypto.randomBytes(12).toString('base64url'), e.id);
    db.exec('UPDATE repair_tasks SET origin_run_id = (SELECT run_id FROM results WHERE results.id = repair_tasks.source_result_id) WHERE origin_run_id IS NULL');
    db.exec(`UPDATE repair_tasks SET closed_at = updated_at WHERE status = 'verified' AND closed_at IS NULL`);
  },
};

export const now = () => new Date().toISOString(); // all timestamps: UTC ISO-8601
export const newUid = () => crypto.randomBytes(12).toString('base64url');

/** Append-only audit trail. Never pass secrets in `detail`. */
export function audit(db, { userId = null, projectId = null, actor = 'user', action, entity = null, entityId = null, detail = {}, requestId = null }) {
  db.run('INSERT INTO audit_events (ts, user_id, project_id, actor, action, entity, entity_id, detail, request_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    now(), userId, projectId, actor, action, entity, entityId, JSON.stringify(detail), requestId);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dir = path.resolve(process.env.DATA_DIR || './data');
  const db = openDb(dir);
  console.log('Migrations applied:', db.all('SELECT name FROM _migrations').map((r) => r.name).join(', '));
  if (process.argv[2] === 'backup') {
    const out = path.resolve(process.argv[3] || path.join(dir, 'backups', `shipproof-${new Date().toISOString().replace(/[:.]/g, '-')}.db`));
    fs.mkdirSync(path.dirname(out), { recursive: true });
    console.log('Backup written:', db.backup(out));
  }
  db.close();
}
