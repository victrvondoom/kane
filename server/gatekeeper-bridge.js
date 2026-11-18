// Gatekeeper Integration Bridge
// Connects SHIPPROOF to the authentic gatekeeper-main package intelligence engine.
// Executes audits, lockfile poisoning checks, and controlled investigator tools.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { invokeEngineWorker } from './engine-worker.js';
import { scanSecurity as fastScanSecurity, recordSecurityScan } from './gatekeeper.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const WORKER_SCRIPT = path.resolve(__dirname, 'gatekeeper-worker.py');

/**
 * Scan a project's workspace using the authentic Gatekeeper engine.
 */
export async function runGatekeeperScan({
  db,
  projectId,
  workspaceDir,
  lockfileContent = null,
  manifestContent = null,
  commitSha = null,
  correlationId = null,
}) {
  // First run fast preliminary analysis
  const fastResult = fastScanSecurity({
    workspaceDir,
    lockfileContent,
    manifestContent,
    commitSha,
  });

  // Now execute the full Gatekeeper worker
  let workerResult = null;
  try {
    workerResult = await invokeEngineWorker({
      engine: 'gatekeeper',
      scriptPath: WORKER_SCRIPT,
      action: 'audit',
      payload: {
        workspaceDir,
        lockfileContent,
      },
      workspaceDir,
      correlationId,
      timeoutMs: 30000,
    });
  } catch (err) {
    // If worker fails, we log and fall back safely to fastResult
    console.error('Gatekeeper worker invocation error:', err);
  }

  // Combine findings: union of fast and worker findings (deduplicating by detail)
  const allFindings = [...(fastResult.findings || [])];
  if (workerResult?.ok && workerResult.data?.findings) {
    const seen = new Set(allFindings.map((f) => f.detail || f.kind));
    for (const f of workerResult.data.findings) {
      if (!seen.has(f.detail || f.kind)) {
        allFindings.push(f);
        seen.add(f.detail || f.kind);
      }
    }
  }

  const hasCritical = allFindings.some((f) => f.severity === 'critical');
  const hasHigh = allFindings.some((f) => f.severity === 'high');
  const hasMedium = allFindings.some((f) => f.severity === 'medium');

  let verdict = 'ALLOWED';
  let summary = 'Security preflight passed: No supply-chain threats detected.';

  if (hasCritical) {
    verdict = 'BLOCKED';
    const crit = allFindings.filter((f) => f.severity === 'critical').map((f) => f.detail).join('; ');
    summary = `Security check BLOCKED: Critical supply chain threats detected (${crit})`;
  } else if (hasHigh) {
    verdict = 'BLOCKED';
    const high = allFindings.filter((f) => f.severity === 'high').map((f) => f.detail).join('; ');
    summary = `Security check BLOCKED: High risk findings detected (${high})`;
  } else if (hasMedium) {
    verdict = 'REQUIRES_REVIEW';
    summary = `Security check REQUIRES REVIEW: ${allFindings.length} non-standard dependencies or hooks present`;
  }

  const finalResult = {
    verdict,
    summary,
    findings: allFindings,
    packageCount: workerResult?.data?.packageCount || fastResult.packageCount || 0,
    commitSha,
    engine: workerResult?.ok ? 'Gatekeeper (gatekeeper-main)' : 'Gatekeeper (fast-preflight)',
    scannedAt: new Date().toISOString(),
  };

  // Persist scan result to security_scans
  const scanId = recordSecurityScan(db, projectId, finalResult);

  // Persist individual audit records to gatekeeper_audits table
  for (const f of allFindings) {
    db.run(
      `INSERT INTO gatekeeper_audits (project_id, scan_id, package_name, package_version, spec_type, risk_level, details_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      projectId,
      scanId,
      f.name || 'unknown',
      f.version || null,
      f.kind || 'finding',
      f.severity || 'medium',
      JSON.stringify(f),
      finalResult.scannedAt
    );
  }

  return {
    scanId,
    ...finalResult,
  };
}

/**
 * Execute an investigator tool on a suspicious package.
 * Tools: 'read', 'search', 'decode', 'strings'
 */
export async function runInvestigatorTool({
  tool,
  toolName,
  targetPath,
  params = {},
  args = {},
  correlationId = null,
}) {
  const effectiveTool = tool || toolName;
  const effectiveParams = { ...params, ...args };
  if (!effectiveParams.query && effectiveParams.pattern) effectiveParams.query = effectiveParams.pattern;
  if (!effectiveParams.file && (effectiveParams.targetPath || targetPath)) effectiveParams.file = effectiveParams.targetPath || targetPath;
  if (!effectiveParams.mode && effectiveParams.encoding) effectiveParams.mode = effectiveParams.encoding;
  const effectiveTargetPath = targetPath || effectiveParams.targetPath || '';
  return invokeEngineWorker({
    engine: 'gatekeeper',
    scriptPath: WORKER_SCRIPT,
    action: 'investigate',
    payload: {
      tool: effectiveTool,
      targetPath: effectiveTargetPath,
      params: effectiveParams,
    },
    correlationId,
    timeoutMs: 15000,
  });
}

/**
 * Retrieve past Gatekeeper audits for a project.
 */
export function getGatekeeperAudits({ db, projectId }) {
  return db.all('SELECT * FROM gatekeeper_audits WHERE project_id = ? ORDER BY id DESC', projectId).map((r) => ({
    ...r,
    findings: JSON.parse(r.findings_json || '[]'),
    advisories: JSON.parse(r.advisories_json || '[]'),
  }));
}

