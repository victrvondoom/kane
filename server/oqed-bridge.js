// OQED Superoptimization Bridge
// Manages native C/C++ candidate optimization, SMT equivalence status, and formal correctness records.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { invokeEngineWorker } from './engine-worker.js';
import { checkOqedStatus, scanProjectNativeTargets, evaluateOqedEligibility } from './oqed.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const WORKER_SCRIPT = path.resolve(__dirname, 'oqed-worker.py');

/**
 * Check OQED optimization eligibility for a project.
 */
export function checkOqedEligibility({ db, projectId, workspaceDir }) {
  return evaluateOqedEligibility(workspaceDir);
}

/**
 * Get past OQED optimization records for a project.
 */
export function getOqedOptimizations({ db, projectId }) {
  return db.all('SELECT * FROM oqed_optimizations WHERE project_id = ? ORDER BY id DESC', projectId).map((r) => ({
    ...r,
    smt_verification: JSON.parse(r.smt_verification_json || '{}'),
  }));
}

/**
 * Execute native optimization pipeline for eligible C/C++ targets in a project workspace.
 */
export async function runOqedOptimization({
  db,
  projectId,
  workspaceDir,
  correlationId = null,
}) {
  const toolchain = checkOqedStatus();
  const targetScan = scanProjectNativeTargets(workspaceDir);

  if (!targetScan.hasNativeTargets) {
    return {
      eligible: false,
      reason: 'No native C/C++ targets found in workspace (JavaScript/web only).',
      candidates: [],
      toolchain,
    };
  }

  // Execute OQED worker
  let workerResult = null;
  try {
    workerResult = await invokeEngineWorker({
      engine: 'oqed',
      scriptPath: WORKER_SCRIPT,
      action: 'evaluate',
      payload: {
        nativeFiles: targetScan.files,
        toolchainReady: toolchain.toolchainReady,
      },
      workspaceDir,
      correlationId,
      timeoutMs: 30000,
    });
  } catch (err) {
    console.error('OQED worker invocation error:', err);
  }

  const data = workerResult?.ok ? workerResult.data : {
    eligible: true,
    supportedEnvironment: toolchain.isLinux && toolchain.isX86_64,
    status: 'UNKNOWN',
    candidates: [],
    reason: workerResult?.error || 'Worker invocation failed',
  };

  const now = new Date().toISOString();

  // Persist candidate optimizations into oqed_optimizations
  for (const c of data.candidates || []) {
    db.run(
      `INSERT INTO oqed_optimizations (
        project_id, target_function, source_file, baseline_cycles, optimized_cycles,
        speedup_ratio, equivalence_status, smt_verification_json, diff_asm, oqed_lock_entry, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      projectId,
      c.targetFunction || 'fn',
      c.file || 'source.c',
      c.baselineCycles || null,
      c.optimizedCycles || null,
      c.speedupRatio || null,
      c.equivalenceStatus || 'UNKNOWN',
      JSON.stringify(c.smtVerification || {}),
      c.diffAsm || null,
      c.oqedLockEntry || null,
      now
    );
  }

  return {
    toolchain,
    targetScan,
    ...data,
  };
}
