// OQED — Native x86-64 C/C++ Superoptimizer & SMT Equivalence Proof Engine
// Strictly for native x86-64 code. Discovers toolchains, checks project target eligibility,
// and ensures no native optimization is ever faked or applied unproven.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const REQUIRED_TOOLS = ['clang', 'gcc', 'as', 'nm', 'objdump', 'llvm-mca'];

/**
 * Inspect system environment and report OQED toolchain readiness.
 */
export function checkOqedStatus() {
  const isLinux = process.platform === 'linux';
  const isX86_64 = process.arch === 'x64';
  const toolStatus = {};

  for (const tool of REQUIRED_TOOLS) {
    const check = spawnSync(process.platform === 'win32' ? 'where' : 'which', [tool], { stdio: 'pipe' });
    toolStatus[tool] = check.status === 0;
  }

  const missingTools = Object.entries(toolStatus).filter(([, ok]) => !ok).map(([t]) => t);
  const toolchainReady = isLinux && isX86_64 && missingTools.length === 0;

  return {
    engine: 'OQED (Superoptimizer for x86-64)',
    platform: process.platform,
    arch: process.arch,
    isLinux,
    isX86_64,
    toolchainReady,
    missingTools,
    toolStatus,
    capability: toolchainReady ? 'READY' : 'UNAVAILABLE_TOOLCHAIN_MISSING',
    reason: !isLinux
      ? `OQED requires a Linux x86-64 environment with clang/gcc/binutils (current host: ${process.platform} ${process.arch}).`
      : missingTools.length > 0
        ? `Missing required toolchains: ${missingTools.join(', ')}.`
        : 'OQED native x86-64 optimization toolchain is fully available.',
  };
}

/**
 * Scan a project workspace for native C/C++ source code targets eligible for OQED.
 */
export function scanProjectNativeTargets(workspaceDir) {
  if (!workspaceDir || !fs.existsSync(workspaceDir)) {
    return { hasNativeTargets: false, files: [], reason: 'Workspace directory does not exist' };
  }

  const nativeFiles = [];
  const searchDirs = [workspaceDir];

  while (searchDirs.length) {
    const current = searchDirs.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'venv' || entry.name === '.venv') continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        searchDirs.push(full);
      } else if (/\.(c|cpp|cc|cxx|h|hpp)$/i.test(entry.name)) {
        nativeFiles.push(path.relative(workspaceDir, full));
      }
    }
  }

  const hasNativeTargets = nativeFiles.length > 0;
  return {
    hasNativeTargets,
    files: nativeFiles,
    reason: hasNativeTargets
      ? `Found ${nativeFiles.length} native source file(s) eligible for C/C++ superoptimization.`
      : 'No native C/C++ targets found in project (SHIPPROOF is a web application). OQED optimization is safely bypassed.',
  };
}

/**
 * Evaluate OQED optimization eligibility for a project.
 */
export function evaluateOqedEligibility(workspaceDir) {
  const status = checkOqedStatus();
  const targetScan = scanProjectNativeTargets(workspaceDir);

  if (!targetScan.hasNativeTargets) {
    return {
      eligible: false,
      code: 'UNAVAILABLE_NO_NATIVE_TARGETS',
      summary: targetScan.reason,
      status,
      targetScan,
    };
  }

  if (!status.toolchainReady) {
    return {
      eligible: false,
      code: 'UNAVAILABLE_TOOLCHAIN_MISSING',
      summary: status.reason,
      status,
      targetScan,
    };
  }

  return {
    eligible: true,
    code: 'READY',
    summary: 'Native C/C++ targets detected and toolchain is ready for formal SMT optimization.',
    status,
    targetScan,
  };
}

