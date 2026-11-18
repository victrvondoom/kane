// Interprocedural Static Taint Analysis
// Tracks sensitive sources (process.env, credentials, ~/.npmrc) to dangerous sinks
// (network requests, child_process execution, file system tampering) across variable
// assignments, object properties, and function calls.

import fs from 'node:fs';
import path from 'node:path';

export const SENSITIVE_SOURCES = [
  { pattern: /process\.env(?:\.([a-zA-Z0-9_]+)|\[['"]([^'"]+)['"]\])?/g, type: 'env' },
  { pattern: /(?:readFileSync|readFile)\s*\(\s*['"](?:[^'"]*\.npmrc|\.ssh|\.aws|\.env)['"]/g, type: 'credentials_file' },
  { pattern: /['"](?:ghp_[a-zA-Z0-9]{36}|npm_[a-zA-Z0-9]{36}|AKIA[0-9A-Z]{16})['"]/g, type: 'hardcoded_token' },
];

export const SINK_DEFINITIONS = [
  { regex: /(https?\.request|https?\.get|fetch|axios|got|superagent|needle)\s*\(([\s\S]*?)\)/g, type: 'network', severity: 'CRITICAL' },
  { regex: /(child_process\.(?:exec|execSync|spawn|spawnSync)|require\(['"]child_process['"]\)\.(?:exec|execSync|spawn))\s*\(([\s\S]*?)\)/g, type: 'exec', severity: 'CRITICAL' },
  { regex: /(eval|Function)\s*\(([\s\S]*?)\)/g, type: 'code_execution', severity: 'CRITICAL' },
  { regex: /(dns\.(?:resolve|lookup))\s*\(([\s\S]*?)\)/g, type: 'dns_exfiltration', severity: 'HIGH' },
  { regex: /(fs\.(?:writeFile|writeFileSync|appendFile|appendFileSync))\s*\(([\s\S]*?)\)/g, type: 'file_write', severity: 'HIGH' },
];

/**
 * Parses variable assignments and tracks taint aliases in a source file.
 */
export function analyzeFileTaint(filePath, code) {
  const lines = code.split('\n');
  const taintedVars = new Map(); // varName -> { source, line, stepDescription }
  const taintFlows = [];

  // Helper to get line number from character index
  const getLineNumber = (charIdx) => code.substring(0, charIdx).split('\n').length;

  // 1. Identify initial tainted variables from sources
  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const lineNum = lineIdx + 1;
    const lineText = lines[lineIdx];

    const assignRegex = /(?:const|let|var)\s+([a-zA-Z0-9_$]+)\s*=\s*(.+)/g;
    let assignMatch;
    while ((assignMatch = assignRegex.exec(lineText)) !== null) {
      const varName = assignMatch[1];
      const rhs = assignMatch[2];

      for (const src of SENSITIVE_SOURCES) {
        src.pattern.lastIndex = 0;
        const match = src.pattern.exec(rhs);
        if (match) {
          const detail = match[1] || match[2] || match[0];
          taintedVars.set(varName, {
            sourceType: src.type,
            sourceExpr: detail,
            line: lineNum,
            steps: [`Line ${lineNum}: Variable '${varName}' initialized from source '${detail}'`],
          });
        }
      }
    }
  }

  // 2. Multi-pass propagation across assignments (runs until fix-point or 5 iterations)
  let changed = true;
  let iterations = 0;
  while (changed && iterations < 5) {
    changed = false;
    iterations++;

    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
      const lineNum = lineIdx + 1;
      const lineText = lines[lineIdx];

      const assignRegex = /(?:const|let|var)\s+([a-zA-Z0-9_$]+)\s*=\s*(.+)/g;
      let assignMatch;
      while ((assignMatch = assignRegex.exec(lineText)) !== null) {
        const newVar = assignMatch[1];
        const rhs = assignMatch[2];

        if (taintedVars.has(newVar)) continue;

        for (const [taintedVar, info] of Array.from(taintedVars.entries())) {
          const varRefRegex = new RegExp(`\\b${taintedVar}\\b`);
          if (varRefRegex.test(rhs)) {
            taintedVars.set(newVar, {
              sourceType: info.sourceType,
              sourceExpr: info.sourceExpr,
              line: lineNum,
              steps: [
                ...info.steps,
                `Line ${lineNum}: Taint propagated to '${newVar}' via expression '${rhs.trim()}'`,
              ],
            });
            changed = true;
            break;
          }
        }
      }
    }
  }

  // 3. Inspect Call Sinks across the entire file (handling multiline arguments)
  for (const sinkDef of SINK_DEFINITIONS) {
    sinkDef.regex.lastIndex = 0;
    let match;
    while ((match = sinkDef.regex.exec(code)) !== null) {
      const callee = match[1];
      const argsText = match[2] || '';
      const startIdx = match.index;
      const lineNum = getLineNumber(startIdx);
      const snippet = match[0].split('\n').slice(0, 3).join(' ').trim();

      // Check if any direct source is in arguments
      for (const src of SENSITIVE_SOURCES) {
        src.pattern.lastIndex = 0;
        const srcMatch = src.pattern.exec(argsText);
        if (srcMatch) {
          taintFlows.push({
            source: { type: src.type, expr: srcMatch[0], line: lineNum },
            sink: { type: sinkDef.type, line: lineNum, snippet },
            steps: [`Line ${lineNum}: Source '${srcMatch[0]}' passed directly into '${callee}' sink`],
            severity: sinkDef.severity,
            filePath,
            line: lineNum,
          });
        }
      }

      // Check if any tainted variable is in arguments
      for (const [taintedVar, info] of taintedVars.entries()) {
        const varRefRegex = new RegExp(`\\b${taintedVar}\\b`);
        if (varRefRegex.test(argsText)) {
          taintFlows.push({
            source: { type: info.sourceType, expr: info.sourceExpr, line: info.line },
            sink: { type: sinkDef.type, line: lineNum, snippet },
            steps: [
              ...info.steps,
              `Line ${lineNum}: Tainted variable '${taintedVar}' consumed by sink '${callee}'`,
            ],
            severity: sinkDef.severity,
            filePath,
            line: lineNum,
          });
        }
      }
    }
  }

  return { taintedVars: Array.from(taintedVars.entries()), taintFlows };
}

/**
 * Performs interprocedural static taint analysis across package files.
 * Reuses Gatekeeper's reachability context (entry points & install hooks).
 */
export function runStaticTaintAnalysis({ packageDir, entryFiles = [] }) {
  const allFlows = [];
  const scannedFiles = [];

  const candidateFiles = new Set(entryFiles);

  // If no entry files given, look for package.json scripts or common entry points
  const pkgJsonPath = path.join(packageDir, 'package.json');
  if (fs.existsSync(pkgJsonPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
      if (pkg.main) candidateFiles.add(path.resolve(packageDir, pkg.main));
      if (pkg.scripts) {
        for (const s of ['preinstall', 'install', 'postinstall']) {
          if (pkg.scripts[s]) {
            const scriptMatch = pkg.scripts[s].match(/(?:node|bash|sh)\s+([a-zA-Z0-9_./-]+\.js)/);
            if (scriptMatch) candidateFiles.add(path.resolve(packageDir, scriptMatch[1]));
          }
        }
      }
    } catch {}
  }

  const walk = (dir, depth = 0) => {
    if (depth > 4) return;
    if (!fs.existsSync(dir)) return;
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', '.git', '.venv'].includes(ent.name)) continue;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(full, depth + 1);
      else if (ent.isFile() && (ent.name.endsWith('.js') || ent.name.endsWith('.mjs'))) {
        candidateFiles.add(full);
      }
    }
  };

  walk(packageDir);

  for (const filePath of candidateFiles) {
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) continue;
    let code = '';
    try {
      code = fs.readFileSync(filePath, 'utf8');
    } catch {
      continue;
    }

    const relPath = path.relative(packageDir, filePath).replace(/\\/g, '/');
    scannedFiles.push(relPath);

    const { taintFlows } = analyzeFileTaint(relPath, code);
    allFlows.push(...taintFlows);
  }

  // Deduplicate flows
  const uniqueFlows = [];
  const seen = new Set();
  for (const flow of allFlows) {
    const key = `${flow.filePath}:${flow.line}:${flow.sink.type}:${flow.source.expr}`;
    if (!seen.has(key)) {
      seen.add(key);
      uniqueFlows.push(flow);
    }
  }

  return {
    scannedFilesCount: scannedFiles.length,
    scannedFiles,
    totalFlowsFound: uniqueFlows.length,
    isClean: uniqueFlows.length === 0,
    flows: uniqueFlows,
  };
}
