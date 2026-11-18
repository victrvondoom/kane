// Hybrid Graph-Based Test Impact Intelligence
// Computes static dependency graph, function call associations, test-to-code mappings,
// and historical failure weights to intelligently select and rank acceptance criteria.

import fs from 'node:fs';
import path from 'node:path';

/**
 * Parses imports and requires from a JS/TS/JSON/Py source file.
 */
export function extractFileDependencies(filePath, fileContent) {
  const deps = new Set();
  const ext = path.extname(filePath).toLowerCase();

  if (['.js', '.mjs', '.cjs', '.ts', '.jsx', '.tsx'].includes(ext)) {
    // ES module imports: import ... from '...' or import('...')
    const importRegex = /(?:import\s+(?:[\w*\s{},]*\s+from\s+)?['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\))/g;
    let match;
    while ((match = importRegex.exec(fileContent)) !== null) {
      const target = match[1] || match[2];
      if (target && !target.startsWith('node:')) deps.add(target);
    }

    // CommonJS require: require('...')
    const requireRegex = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
    while ((match = requireRegex.exec(fileContent)) !== null) {
      const target = match[1];
      if (target && !target.startsWith('node:')) deps.add(target);
    }
  } else if (ext === '.py') {
    // Python imports: from x import y or import x
    const pyRegex = /(?:^|\n)\s*(?:from\s+([\w.]+)\s+import|import\s+([\w.]+))/g;
    let match;
    while ((match = pyRegex.exec(fileContent)) !== null) {
      const target = match[1] || match[2];
      if (target) deps.add(target.replace(/\./g, '/'));
    }
  }

  return Array.from(deps);
}

/**
 * Extracts exported functions, classes, and top-level symbols from code.
 */
export function extractSymbols(filePath, fileContent) {
  const symbols = [];
  const ext = path.extname(filePath).toLowerCase();

  if (['.js', '.mjs', '.cjs', '.ts', '.jsx', '.tsx'].includes(ext)) {
    // Match export function X, export const X, function X, class X
    const fnRegex = /(?:export\s+(?:default\s+)?)?(?:function|class)\s+([a-zA-Z0-9_$]+)/g;
    let match;
    while ((match = fnRegex.exec(fileContent)) !== null) {
      symbols.push({ name: match[1], type: 'declaration', line: fileContent.substring(0, match.index).split('\n').length });
    }

    const constRegex = /(?:export\s+)?(?:const|let|var)\s+([a-zA-Z0-9_$]+)\s*=\s*(?:function|\([^)]*\)\s*=>)/g;
    while ((match = constRegex.exec(fileContent)) !== null) {
      symbols.push({ name: match[1], type: 'arrow_function', line: fileContent.substring(0, match.index).split('\n').length });
    }
  } else if (ext === '.py') {
    const pyDef = /(?:^|\n)\s*def\s+([a-zA-Z0-9_]+)\s*\(/g;
    let match;
    while ((match = pyDef.exec(fileContent)) !== null) {
      symbols.push({ name: match[1], type: 'function', line: fileContent.substring(0, match.index).split('\n').length });
    }
  }

  return symbols;
}

/**
 * Builds the comprehensive multi-layered dependency graph of the workspace.
 */
export function buildWorkspaceGraph(rootDir, options = {}) {
  const graph = {
    nodes: new Map(), // id -> { id, type, path, symbols }
    adjacency: new Map(), // id -> Set of targets
    reverseAdjacency: new Map(), // id -> Set of incoming sources
  };

  const addNode = (id, data) => {
    if (!graph.nodes.has(id)) {
      graph.nodes.set(id, { id, ...data });
      graph.adjacency.set(id, new Set());
      graph.reverseAdjacency.set(id, new Set());
    }
  };

  const addEdge = (fromId, toId) => {
    addNode(fromId, { type: 'unknown' });
    addNode(toId, { type: 'unknown' });
    graph.adjacency.get(fromId).add(toId);
    graph.reverseAdjacency.get(toId).add(fromId);
  };

  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const ent of entries) {
      if (['node_modules', '.git', '.venv', 'dist', 'build', 'coverage'].includes(ent.name)) continue;
      const fullPath = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        walk(fullPath);
      } else if (ent.isFile()) {
        const ext = path.extname(ent.name).toLowerCase();
        if (['.js', '.mjs', '.cjs', '.ts', '.jsx', '.tsx', '.json', '.py'].includes(ext)) {
          const relPath = path.relative(rootDir, fullPath).replace(/\\/g, '/');
          let content = '';
          try {
            content = fs.readFileSync(fullPath, 'utf8');
          } catch {
            continue;
          }
          const symbols = extractSymbols(relPath, content);
          addNode(relPath, { type: 'file', path: relPath, symbols });

          const rawDeps = extractFileDependencies(relPath, content);
          for (const rawDep of rawDeps) {
            // Resolve relative path
            let resolved = null;
            if (rawDep.startsWith('.')) {
              const absDep = path.resolve(path.dirname(fullPath), rawDep);
              const candidates = [
                absDep,
                absDep + '.js',
                absDep + '.ts',
                absDep + '.mjs',
                absDep + '.json',
                path.join(absDep, 'index.js'),
              ];
              for (const cand of candidates) {
                if (fs.existsSync(cand) && fs.statSync(cand).isFile()) {
                  resolved = path.relative(rootDir, cand).replace(/\\/g, '/');
                  break;
                }
              }
            } else {
              // Internal alias or package
              resolved = rawDep;
            }

            if (resolved) {
              addEdge(relPath, resolved);
            }
          }
        }
      }
    }
  };

  walk(rootDir);
  return graph;
}

/**
 * Checks if a file path matches criterion path patterns.
 */
export function matchesCriterionPaths(filePath, criterionPaths) {
  if (!criterionPaths || criterionPaths.length === 0) return false;
  const normalized = filePath.replace(/\\/g, '/');
  for (const pat of criterionPaths) {
    const cleanPat = pat.replace(/\\/g, '/');
    if (cleanPat === '*' || cleanPat === '**') return true;
    if (normalized === cleanPat) return true;
    if (normalized.startsWith(cleanPat.replace(/\*.*$/, ''))) return true;
    // Simple glob matching
    if (cleanPat.includes('*')) {
      const regex = new RegExp('^' + cleanPat.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
      if (regex.test(normalized)) return true;
    }
  }
  return false;
}

/**
 * Traverses graph to compute shortest distance from any changed file to target.
 */
export function computeGraphDistances(graph, changedFiles) {
  const distances = new Map();
  const paths = new Map();
  const queue = [];

  for (const f of changedFiles) {
    const norm = f.replace(/\\/g, '/');
    distances.set(norm, 0);
    paths.set(norm, [norm]);
    queue.push(norm);
  }

  // Follow both incoming dependencies (who depends on changed file) and outgoing
  while (queue.length > 0) {
    const current = queue.shift();
    const currentDist = distances.get(current);
    const currentPath = paths.get(current);

    // Dependent nodes (files that import current)
    const incoming = graph.reverseAdjacency.get(current) || new Set();
    // Outgoing nodes (files imported by current)
    const outgoing = graph.adjacency.get(current) || new Set();

    const neighbors = [...incoming, ...outgoing];
    for (const nbr of neighbors) {
      if (!distances.has(nbr)) {
        distances.set(nbr, currentDist + 1);
        paths.set(nbr, [...currentPath, nbr]);
        queue.push(nbr);
      }
    }
  }

  return { distances, paths };
}

/**
 * Calculates historical failure rate and average duration for criteria.
 */
export function getCriterionHistoricalMetrics(db, projectId) {
  const metrics = new Map();
  if (!db) return metrics;

  try {
    const rows = db.all(
      `SELECT r.criterion_id, r.status, r.duration_ms 
       FROM results r
       JOIN criteria c ON c.id = r.criterion_id
       WHERE c.project_id = ? 
       ORDER BY r.id DESC LIMIT 500`,
      projectId
    );

    for (const r of rows) {
      if (!metrics.has(r.criterion_id)) {
        metrics.set(r.criterion_id, { total: 0, failed: 0, totalDuration: 0 });
      }
      const m = metrics.get(r.criterion_id);
      m.total += 1;
      if (r.status === 'failed') m.failed += 1;
      m.totalDuration += r.duration_ms || 1000;
    }
  } catch {
    // Graceful fallback if database query is not available
  }

  return metrics;
}

/**
 * Core Algorithm One: Hybrid Test Impact Analysis & Selection.
 */
export function analyzeTestImpact({
  workspaceRoot,
  changedFiles = [],
  criteria = [],
  db = null,
  projectId = null,
  budget = {},
}) {
  const maxTests = budget.maxTests || Infinity;
  const timeBudgetMs = budget.timeBudgetMs || Infinity;
  const minConfidence = budget.minConfidence || 0.1;

  const normalizedChanges = changedFiles.map((f) => f.replace(/\\/g, '/'));
  const graph = buildWorkspaceGraph(workspaceRoot);
  const { distances, paths } = computeGraphDistances(graph, normalizedChanges);
  const history = getCriterionHistoricalMetrics(db, projectId);

  const scoredCriteria = [];

  for (const crit of criteria) {
    const critPaths = Array.isArray(crit.paths)
      ? crit.paths
      : (typeof crit.paths === 'string' ? JSON.parse(crit.paths || '[]') : []);

    let minDistance = Infinity;
    let closestFile = null;
    let matchType = 'none';
    let causalPath = [];

    // 1. Direct file match
    for (const change of normalizedChanges) {
      if (matchesCriterionPaths(change, critPaths)) {
        minDistance = 0;
        closestFile = change;
        matchType = 'direct_change';
        causalPath = [change];
        break;
      }
    }

    // 2. Graph dependency reachability
    if (minDistance > 0 && critPaths.length > 0) {
      for (const cp of critPaths) {
        const normCp = cp.replace(/\\/g, '/');
        if (distances.has(normCp)) {
          const d = distances.get(normCp);
          if (d < minDistance) {
            minDistance = d;
            closestFile = normCp;
            matchType = 'dependency';
            causalPath = paths.get(normCp) || [normCp];
          }
        }
      }
    }

    // 3. Fallback: If no paths specified or no graph match, compute reachability to project entry
    if (minDistance === Infinity) {
      // Check if changed files are core files (e.g. server/app.js, package.json)
      const hasCoreChange = normalizedChanges.some((c) =>
        c.includes('app.js') || c.includes('index.js') || c.includes('package.json')
      );
      if (hasCoreChange) {
        minDistance = 2;
        matchType = 'core_entry_impact';
        causalPath = [normalizedChanges[0], 'app.js', crit.id];
      }
    }

    // Compute Historical Failure Rate
    const hist = history.get(crit.id) || { total: 0, failed: 0, totalDuration: 2000 };
    const failRate = hist.total > 0 ? hist.failed / hist.total : 0.2; // default 20% prior
    const avgDurationMs = hist.total > 0 ? Math.round(hist.totalDuration / hist.total) : 2500;

    // Weight coefficients:
    // S(c) = w_dist * (1 / (1 + d)) + w_fail * failRate + w_priority
    const wDist = 0.55;
    const wFail = 0.35;
    const wCrit = 0.10;

    const distScore = minDistance < Infinity ? 1 / (1 + minDistance) : 0;
    const priorityWeight = crit.priority === 'critical' ? 1.0 : (crit.priority === 'high' ? 0.8 : 0.5);

    const impactScore = Number((wDist * distScore + wFail * failRate + wCrit * priorityWeight).toFixed(4));

    // Construct human-readable reason
    let reason = '';
    if (matchType === 'direct_change') {
      reason = `Direct match: modified file '${closestFile}' satisfies criterion path pattern.`;
    } else if (matchType === 'dependency') {
      reason = `Transitive impact: '${closestFile}' is connected via ${minDistance} import hop(s) [${causalPath.join(' → ')}].`;
    } else if (matchType === 'core_entry_impact') {
      reason = `Core framework modification affects shared application pipeline.`;
    } else if (failRate > 0.4) {
      reason = `Elevated regression risk: criterion has ${Math.round(failRate * 100)}% historical failure rate.`;
    } else {
      reason = `Indirect regression candidate (heuristic confidence ${impactScore}).`;
    }

    scoredCriteria.push({
      criterionId: crit.id,
      text: crit.text,
      category: crit.category,
      impactScore,
      distance: minDistance < Infinity ? minDistance : -1,
      matchType,
      causalPath,
      historicalFailRate: Number(failRate.toFixed(2)),
      estimatedDurationMs: avgDurationMs,
      reason,
      selected: false,
    });
  }

  // Sort by impact score descending
  scoredCriteria.sort((a, b) => b.impactScore - a.impactScore);

  // Apply Budget Constraints (Greedy Selection)
  let accumulatedTime = 0;
  let selectedCount = 0;

  for (const item of scoredCriteria) {
    if (item.impactScore < minConfidence && selectedCount > 0) continue;
    if (selectedCount >= maxTests) break;
    if (accumulatedTime + item.estimatedDurationMs > timeBudgetMs && selectedCount > 0) continue;

    item.selected = true;
    accumulatedTime += item.estimatedDurationMs;
    selectedCount += 1;
  }

  // Ensure at least 1 test is selected if criteria exist and there were changed files
  if (selectedCount === 0 && scoredCriteria.length > 0) {
    scoredCriteria[0].selected = true;
    selectedCount = 1;
    accumulatedTime = scoredCriteria[0].estimatedDurationMs;
  }

  return {
    totalCriteria: criteria.length,
    selectedCount,
    estimatedTotalDurationMs: accumulatedTime,
    confidenceScore: Number(
      (scoredCriteria.filter((c) => c.selected).reduce((acc, c) => acc + c.impactScore, 0) / (selectedCount || 1)).toFixed(3)
    ),
    results: scoredCriteria,
  };
}
