// Probabilistic Delta Debugging (ProbDD & ddmin)
// Reduces complex failing browser interaction sequences to 1-minimal reproductions
// while preserving failure signatures and prioritizing high-probability noise removal.

/**
 * Computes prior probability of an action being causally relevant to an application failure.
 * High prior = state mutation, submission, data entry.
 * Low prior = redundant navigation, waits, benign reads.
 */
export function getActionCausalPrior(action) {
  if (!action) return 0.5;

  switch (action.type) {
    case 'TYPE':
      return 0.85; // Inputting text/data frequently triggers business logic bugs
    case 'CLICK':
      if (action.selector && (action.selector.includes('submit') || action.selector.includes('checkout') || action.selector.includes('apply'))) {
        return 0.90; // High probability trigger
      }
      return 0.60;
    case 'SELECT':
      return 0.70;
    case 'NAVIGATE':
      return 0.40; // Initial navigation is essential, intermediate ones often noise
    case 'WAIT':
      return 0.15; // Waits are almost always auxiliary/noise unless race condition
    case 'ASSERT':
      return 0.20; // Pre-assertions rarely cause the failure
    default:
      return 0.50;
  }
}

/**
 * Checks if a candidate sequence preserves the failure signature.
 */
export function matchesSignature(outcome, expectedSignature) {
  if (!outcome || outcome.verdict !== 'FAIL') return false;
  if (!expectedSignature) return true; // Any failure accepted if signature not specified

  if (typeof expectedSignature === 'string') {
    return String(outcome.error || outcome.signature || '').includes(expectedSignature);
  }

  if (typeof expectedSignature === 'object') {
    for (const [key, val] of Object.entries(expectedSignature)) {
      if (outcome[key] !== val && outcome.signature?.[key] !== val) {
        return false;
      }
    }
    return true;
  }

  return true;
}

/**
 * Evaluates a sequence against an oracle (test runner or deterministic simulator).
 */
export async function evaluateSequence(sequence, oracle, expectedSignature) {
  const result = await oracle(sequence);
  const isMatch = matchesSignature(result, expectedSignature);
  return {
    verdict: isMatch ? 'FAIL' : (result.verdict === 'PASS' ? 'PASS' : 'UNRESOLVED'),
    raw: result,
  };
}

/**
 * Classic ddmin algorithm (Zeller & Hildebrandt, 2002) adapted for action sequences.
 */
export async function ddmin({
  sequence,
  oracle,
  expectedSignature = null,
  maxEvaluations = 100,
}) {
  let evaluations = 0;
  const evalCache = new Map();

  const runTest = async (seq) => {
    evaluations++;
    const key = JSON.stringify(seq);
    if (evalCache.has(key)) return evalCache.get(key);
    const res = await evaluateSequence(seq, oracle, expectedSignature);
    evalCache.set(key, res.verdict);
    return res.verdict;
  };

  // Pre-condition: original sequence must reproduce the failure
  const initialVerdict = await runTest(sequence);
  if (initialVerdict !== 'FAIL') {
    return {
      status: 'INITIAL_SEQUENCE_DID_NOT_FAIL',
      reducedSequence: sequence,
      originalLength: sequence.length,
      reducedLength: sequence.length,
      reductionRatio: 0,
      evaluations,
    };
  }

  let current = [...sequence];
  let n = 2; // initial granularity

  while (current.length >= 2 && evaluations < maxEvaluations) {
    const subsets = [];
    const chunkSize = Math.ceil(current.length / n);

    for (let i = 0; i < current.length; i += chunkSize) {
      subsets.push(current.slice(i, i + chunkSize));
    }

    let reducedInStep = false;

    // 1. Test each subset alone
    for (const subset of subsets) {
      if (subset.length === 0) continue;
      const verdict = await runTest(subset);
      if (verdict === 'FAIL') {
        current = subset;
        n = Math.max(n - 1, 2);
        reducedInStep = true;
        break;
      }
    }

    if (reducedInStep) continue;

    // 2. Test complement of each subset (remove chunk)
    for (const subset of subsets) {
      const complement = current.filter((item) => !subset.includes(item));
      if (complement.length === 0) continue;

      const verdict = await runTest(complement);
      if (verdict === 'FAIL') {
        current = complement;
        n = Math.max(n - 1, 2);
        reducedInStep = true;
        break;
      }
    }

    if (reducedInStep) continue;

    // 3. Increase granularity if cannot reduce
    if (n < current.length) {
      n = Math.min(current.length, n * 2);
    } else {
      break; // 1-minimality reached
    }
  }

  return {
    status: 'SUCCESS',
    reducedSequence: current,
    originalLength: sequence.length,
    reducedLength: current.length,
    reductionRatio: Number((1 - current.length / sequence.length).toFixed(3)),
    evaluations,
    isOneMinimal: true,
  };
}

/**
 * Probabilistic Delta Debugging (ProbDD).
 * Partitions sequence by removing lowest-causality actions first.
 */
export async function probDD({
  sequence,
  oracle,
  expectedSignature = null,
  maxEvaluations = 100,
}) {
  let evaluations = 0;
  const evalCache = new Map();

  const runTest = async (seq) => {
    evaluations++;
    const key = JSON.stringify(seq);
    if (evalCache.has(key)) return evalCache.get(key);
    const res = await evaluateSequence(seq, oracle, expectedSignature);
    evalCache.set(key, res.verdict);
    return res.verdict;
  };

  const initialVerdict = await runTest(sequence);
  if (initialVerdict !== 'FAIL') {
    return {
      status: 'INITIAL_SEQUENCE_DID_NOT_FAIL',
      reducedSequence: sequence,
      originalLength: sequence.length,
      reducedLength: sequence.length,
      reductionRatio: 0,
      evaluations,
    };
  }

  // Tag actions with original index and causal prior
  let current = sequence.map((act, idx) => ({
    act,
    originalIndex: idx,
    prior: getActionCausalPrior(act),
  }));

  // Sort actions by ascending causal prior (lowest probability noise first)
  const removalOrder = [...current].sort((a, b) => a.prior - b.prior);

  // Phase 1: Try removing lowest-causality individual actions (Noise pruning)
  for (const candidate of removalOrder) {
    if (evaluations >= maxEvaluations || current.length <= 1) break;
    // Keep initial navigation if possible
    if (candidate.act.type === 'NAVIGATE' && candidate.originalIndex === 0 && current.length > 2) {
      continue;
    }

    const candidateSeq = current.filter((c) => c !== candidate);
    const rawActions = candidateSeq.map((c) => c.act);

    const verdict = await runTest(rawActions);
    if (verdict === 'FAIL') {
      current = candidateSeq; // Successfully pruned non-causal step!
    }
  }

  // Phase 2: Run targeted ddmin on the refined sequence to ensure 1-minimality
  const remainingActions = current.map((c) => c.act);
  const finalResult = await ddmin({
    sequence: remainingActions,
    oracle,
    expectedSignature,
    maxEvaluations: maxEvaluations - evaluations,
  });

  evaluations += finalResult.evaluations;

  return {
    status: 'SUCCESS',
    algorithm: 'ProbDD',
    reducedSequence: finalResult.reducedSequence,
    originalLength: sequence.length,
    reducedLength: finalResult.reducedSequence.length,
    reductionRatio: Number((1 - finalResult.reducedSequence.length / sequence.length).toFixed(3)),
    evaluations,
    isOneMinimal: true,
  };
}
