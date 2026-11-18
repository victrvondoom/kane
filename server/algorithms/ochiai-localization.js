// Ochiai Spectrum-Based Fault Localization (SBFL)
// Computes suspiciousness scores for software components (files, functions, modules)
// using execution spectrum matrices and test pass/fail outcomes.
// Formula: Ochiai(c) = n_ef / sqrt(n_f * (n_ef + n_ep))

/**
 * Calculates the Ochiai suspiciousness coefficient.
 * @param {number} n_ef - Failed tests executing component
 * @param {number} n_ep - Passed tests executing component
 * @param {number} n_f  - Total failed tests
 * @param {number} n_p  - Total passed tests
 */
export function calculateOchiaiScore(n_ef, n_ep, n_f, n_p) {
  if (n_f === 0) return 0;
  const denominator = Math.sqrt(n_f * (n_ef + n_ep));
  if (denominator === 0) return 0;
  return Number((n_ef / denominator).toFixed(4));
}

/**
 * Calculates additional SBFL metrics for comparison (Tarantula, DStar).
 */
export function calculateComparativeMetrics(n_ef, n_ep, n_f, n_p) {
  // Tarantula
  let tarantula = 0;
  if (n_f > 0 && n_p > 0) {
    const failRatio = n_ef / n_f;
    const passRatio = n_ep / n_p;
    if (failRatio + passRatio > 0) {
      tarantula = Number((failRatio / (failRatio + passRatio)).toFixed(4));
    }
  }

  // DStar (star = 2)
  const n_nf = n_f - n_ef;
  let dstar = 0;
  if (n_nf + n_ep > 0) {
    dstar = Number(((n_ef * n_ef) / (n_nf + n_ep)).toFixed(4));
  } else if (n_ef > 0) {
    dstar = 999.0;
  }

  return { tarantula, dstar };
}

/**
 * Runs Ochiai Spectrum-Based Fault Localization.
 *
 * @param {Object} params
 * @param {Array<{ testId: string, outcome: 'PASS'|'FAIL'|'passed'|'failed', coverage: string[] }>} params.executions
 * @param {string[]} [params.allComponents] Optional list of all components
 */
export function localizeFaults({ executions = [], allComponents = null }) {
  let n_f = 0;
  let n_p = 0;

  const componentStats = new Map(); // component -> { n_ef, n_ep, testsFailed: [], testsPassed: [] }

  const ensureComponent = (c) => {
    if (!componentStats.has(c)) {
      componentStats.set(c, { n_ef: 0, n_ep: 0, testsFailed: [], testsPassed: [] });
    }
    return componentStats.get(c);
  };

  if (allComponents) {
    for (const c of allComponents) ensureComponent(c);
  }

  // Aggregate test execution matrix
  for (const exec of executions) {
    const isFail = exec.outcome === 'FAIL' || exec.outcome === 'failed';
    const isPass = exec.outcome === 'PASS' || exec.outcome === 'passed';

    if (isFail) n_f++;
    else if (isPass) n_p++;
    else continue; // ignore inconclusive / error

    const covered = new Set(exec.coverage || []);
    for (const c of covered) {
      const stats = ensureComponent(c);
      if (isFail) {
        stats.n_ef++;
        stats.testsFailed.push(exec.testId);
      } else {
        stats.n_ep++;
        stats.testsPassed.push(exec.testId);
      }
    }
  }

  // Compute Ochiai and comparative scores
  const rankings = [];

  for (const [component, stats] of componentStats.entries()) {
    const ochiai = calculateOchiaiScore(stats.n_ef, stats.n_ep, n_f, n_p);
    const comparative = calculateComparativeMetrics(stats.n_ef, stats.n_ep, n_f, n_p);

    rankings.push({
      component,
      ochiaiScore: ochiai,
      tarantulaScore: comparative.tarantula,
      dstarScore: comparative.dstar,
      n_ef: stats.n_ef,
      n_ep: stats.n_ep,
      totalExecutions: stats.n_ef + stats.n_ep,
      testsFailed: stats.testsFailed,
      testsPassed: stats.testsPassed,
      // Explainability reason
      suspicionLevel: ochiai >= 0.8 ? 'CRITICAL' : (ochiai >= 0.5 ? 'HIGH' : (ochiai >= 0.2 ? 'MEDIUM' : 'LOW')),
    });
  }

  // Sort descending by Ochiai score, then by n_ef, then by total executions
  rankings.sort((a, b) => {
    if (b.ochiaiScore !== a.ochiaiScore) return b.ochiaiScore - a.ochiaiScore;
    if (b.n_ef !== a.n_ef) return b.n_ef - a.n_ef;
    return a.n_ep - b.n_ep;
  });

  return {
    totalFailedTests: n_f,
    totalPassedTests: n_p,
    totalComponentsEvaluated: componentStats.size,
    topSuspicious: rankings.slice(0, 10),
    allRankings: rankings,
  };
}

/**
 * Builds an actionable repair dossier connecting Ochiai fault rankings to failing criteria.
 */
export function buildFaultRepairDossier({ localizationResult, criteria = [] }) {
  const topFault = localizationResult.topSuspicious[0];
  if (!topFault || topFault.ochiaiScore === 0) {
    return {
      status: 'NO_SUSPICIOUS_FAULT_IDENTIFIED',
      message: 'No components exhibited strong correlation with test failures.',
    };
  }

  const failingCriterionMap = new Map(criteria.map((c) => [c.id, c]));
  const correlatedCriteria = topFault.testsFailed
    .map((tid) => failingCriterionMap.get(tid))
    .filter(Boolean);

  return {
    status: 'FAULT_LOCALIZED',
    primaryFaultCandidate: topFault.component,
    ochiaiScore: topFault.ochiaiScore,
    suspicionLevel: topFault.suspicionLevel,
    evidence: {
      failingExecutionsCount: topFault.n_ef,
      passingExecutionsCount: topFault.n_ep,
      failingTests: topFault.testsFailed,
    },
    correlatedCriteria: correlatedCriteria.map((c) => ({ id: c.id, text: c.text })),
    recommendedRepairContext: {
      targetFile: topFault.component,
      suggestedInvestigation: `Component '${topFault.component}' was executed in ${topFault.n_ef} failing tests and only ${topFault.n_ep} passing tests (Ochiai score: ${topFault.ochiaiScore}).`,
    },
  };
}
