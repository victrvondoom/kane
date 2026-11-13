// SQLite persistence (built-in node:sqlite) with file-based migrations.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function openDb(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, 'shipproof.db'));
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
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
      db.prepare('INSERT INTO _migrations VALUES (?, ?)').run(f, new Date().toISOString());
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  }
}

export const now = () => new Date().toISOString();

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dir = path.resolve(process.env.DATA_DIR || './data');
  const db = openDb(dir);
  console.log('Migrations applied:', db.all('SELECT name FROM _migrations').map((r) => r.name).join(', '));
  db.close();
}
