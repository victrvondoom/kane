// Gatekeeper — Security & Pre-Execution Inspection Engine
// Evaluates package manifests, lockfiles, and code changes before execution.
// Supports both high-speed native inspection and Python Gatekeeper integration.
import fs from 'node:fs';
import path from 'node:path';
import { now } from './db.js';

export const VERDICTS = {
  ALLOWED: 'ALLOWED',
  BLOCKED: 'BLOCKED',
  REQUIRES_REVIEW: 'REQUIRES_REVIEW',
  INCONCLUSIVE: 'INCONCLUSIVE',
};

const TRUSTED_REGISTRIES = ['registry.npmjs.org', 'registry.yarnpkg.com'];

// Suspicious command patterns in npm lifecycle scripts
const SUSPICIOUS_SCRIPT_PATTERNS = [
  /\b(curl|wget)\b.*\|\s*(sh|bash|powershell|cmd)/i,
  /\b(node\s+-e|eval|exec\(|Buffer\.from\(.*base64)/i,
  /\b(netcat|nc|socat|whoami|cat\s+\/etc\/passwd)\b/i,
  /\b(Invoke-WebRequest|Invoke-Expression|iex|iwr)\b/i,
  /\b(webhook\.site|burpcollaborator|ngrok\.io|serveo\.net)\b/i,
];

// Known compromised or prototype malicious packages for tests & local intelligence
const KNOWN_MALICIOUS_PACKAGES = new Set([
  'tailwindcss-visual-kit',
  'hs-framework',
  'dependencykfeg',
  'malware-test-poc',
  'evil-telemetry-pkg',
  'simple-crypt-hack',
]);

/**
 * Scan a target workspace or lockfile text and return an actionable security verdict.
 */
export function scanSecurity({ workspaceDir, lockfileContent, manifestContent, commitSha = null }) {
  const findings = [];
  let packageCount = 0;

  // 1. Inspect package.json manifest
  let manifest = null;
  try {
    if (manifestContent) {
      manifest = typeof manifestContent === 'string' ? JSON.parse(manifestContent) : manifestContent;
    } else if (workspaceDir && fs.existsSync(path.join(workspaceDir, 'package.json'))) {
      manifest = JSON.parse(fs.readFileSync(path.join(workspaceDir, 'package.json'), 'utf8'));
    }
  } catch (err) {
    findings.push({
      kind: 'manifest_parse_error',
      severity: 'high',
      detail: `Could not parse package.json: ${err.message}`,
    });
  }

  if (manifest) {
    // Check install scripts
    const scripts = manifest.scripts || {};
    for (const [hook, cmd] of Object.entries(scripts)) {
      if (['preinstall', 'install', 'postinstall'].includes(hook)) {
        const isSuspicious = SUSPICIOUS_SCRIPT_PATTERNS.some((p) => p.test(cmd));
        if (isSuspicious) {
          findings.push({
            kind: 'dangerous_lifecycle_script',
            severity: 'critical',
            name: manifest.name || 'root',
            hook,
            detail: `Lifecycle hook "${hook}" executes suspicious command: ${cmd}`,
          });
        } else {
          findings.push({
            kind: 'lifecycle_hook_detected',
            severity: 'medium',
            name: manifest.name || 'root',
            hook,
            detail: `Package declares install-time script "${hook}": ${cmd}`,
          });
        }
      }
    }

    // Check direct dependencies
    const allDeps = {
      ...(manifest.dependencies || {}),
      ...(manifest.devDependencies || {}),
    };
    packageCount += Object.keys(allDeps).length;

    for (const [name, version] of Object.entries(allDeps)) {
      if (KNOWN_MALICIOUS_PACKAGES.has(name.toLowerCase())) {
        findings.push({
          kind: 'known_malicious_dependency',
          severity: 'critical',
          name,
          version,
          detail: `Dependency "${name}" matches known malicious package registry`,
        });
      }
      if (version.startsWith('git+') || version.startsWith('http://') || version.startsWith('https://')) {
        findings.push({
          kind: 'untrusted_dependency_source',
          severity: 'high',
          name,
          version,
          detail: `Dependency "${name}" resolved to direct URL/git source instead of public registry: ${version}`,
        });
      }
    }
  }

  // 2. Inspect package-lock.json if available
  let lock = null;
  try {
    if (lockfileContent) {
      lock = typeof lockfileContent === 'string' ? JSON.parse(lockfileContent) : lockfileContent;
    } else if (workspaceDir && fs.existsSync(path.join(workspaceDir, 'package-lock.json'))) {
      lock = JSON.parse(fs.readFileSync(path.join(workspaceDir, 'package-lock.json'), 'utf8'));
    }
  } catch (err) {
    findings.push({
      kind: 'lockfile_parse_error',
      severity: 'medium',
      detail: `Could not parse lockfile: ${err.message}`,
    });
  }

  if (lock) {
    const packages = lock.packages || {};
    const pkgEntries = Object.entries(packages);
    packageCount = Math.max(packageCount, pkgEntries.length);

    for (const [pkgPath, entry] of pkgEntries) {
      if (!pkgPath || !entry || typeof entry !== 'object' || entry.link) continue;
      const pkgName = entry.name || pkgPath.split('node_modules/').pop();
      const resolved = entry.resolved || '';
      const integrity = entry.integrity || '';

      // Check known malicious
      if (KNOWN_MALICIOUS_PACKAGES.has(pkgName.toLowerCase())) {
        findings.push({
          kind: 'known_malicious_package',
          severity: 'critical',
          name: pkgName,
          version: entry.version,
          detail: `Locked package "${pkgName}" is flagged by malware database`,
        });
      }

      // Check resolved URL host
      if (resolved) {
        try {
          const u = new URL(resolved);
          if (!TRUSTED_REGISTRIES.includes(u.hostname)) {
            findings.push({
              kind: 'untrusted_registry_host',
              severity: 'high',
              name: pkgName,
              version: entry.version,
              detail: `Package "${pkgName}" resolved to non-standard registry host: ${u.hostname}`,
            });
          }

          // Lockfile poisoning check: URL tarball name must match package name
          const expectedBase = pkgName.includes('/') ? pkgName.split('/').pop() : pkgName;
          const tarballFile = path.basename(u.pathname);
          if (!tarballFile.startsWith(expectedBase + '-')) {
            findings.push({
              kind: 'poisoned_lockfile_entry',
              severity: 'critical',
              name: pkgName,
              version: entry.version,
              detail: `Lockfile poisoning: Package "${pkgName}" resolves to mismatched tarball "${tarballFile}"`,
            });
          }
        } catch {
          findings.push({
            kind: 'malformed_resolved_url',
            severity: 'high',
            name: pkgName,
            version: entry.version,
            detail: `Malformed resolved URL: "${resolved}"`,
          });
        }
      }

      // Integrity hash check
      if (!integrity) {
        findings.push({
          kind: 'missing_integrity_checksum',
          severity: 'medium',
          name: pkgName,
          version: entry.version,
          detail: `Package "${pkgName}" lacks sha512 integrity checksum`,
        });
      }
    }
  }

  // 3. Compute final Gatekeeper verdict
  const hasCritical = findings.some((f) => f.severity === 'critical');
  const hasHigh = findings.some((f) => f.severity === 'high');
  const hasMedium = findings.some((f) => f.severity === 'medium');

  let verdict = VERDICTS.ALLOWED;
  let summary = 'Security preflight passed: No supply-chain anomalies or malicious packages detected.';

  if (hasCritical) {
    verdict = VERDICTS.BLOCKED;
    const crit = findings.filter((f) => f.severity === 'critical').map((f) => f.detail).join('; ');
    summary = `Security check BLOCKED: Critical threats detected (${crit})`;
  } else if (hasHigh) {
    verdict = VERDICTS.BLOCKED;
    const high = findings.filter((f) => f.severity === 'high').map((f) => f.detail).join('; ');
    summary = `Security check BLOCKED: High risk findings detected (${high})`;
  } else if (hasMedium) {
    verdict = VERDICTS.REQUIRES_REVIEW;
    summary = `Security check REQUIRES REVIEW: Non-standard dependencies or hooks present (${findings.length} findings)`;
  }

  return {
    verdict,
    summary,
    findings,
    packageCount,
    commitSha,
    scannedAt: now(),
  };
}

/**
 * Persist security scan result into database.
 */
export function recordSecurityScan(db, projectId, scanResult) {
  const res = db.run(
    `INSERT INTO security_scans (project_id, commit_sha, verdict, summary, findings_json, package_count, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    projectId,
    scanResult.commitSha || null,
    scanResult.verdict,
    scanResult.summary,
    JSON.stringify(scanResult.findings || []),
    scanResult.packageCount || 0,
    scanResult.scannedAt || now()
  );
  return Number(res.lastInsertRowid);
}

export function getLatestSecurityScan(db, projectId) {
  const row = db.get('SELECT * FROM security_scans WHERE project_id = ? ORDER BY id DESC LIMIT 1', projectId);
  if (!row) return null;
  return {
    id: row.id,
    projectId: row.project_id,
    commitSha: row.commit_sha,
    verdict: row.verdict,
    summary: row.summary,
    findings: JSON.parse(row.findings_json || '[]'),
    packageCount: row.package_count,
    createdAt: row.created_at,
  };
}

