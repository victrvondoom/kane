// NSGA-II Multi-Objective Automated Exploration
// Pareto optimization of browser interaction sequences across:
// 1. State coverage (unique DOM/URL states) [Maximize]
// 2. Interaction diversity (entropy of action distributions) [Maximize]
// 3. Defect-reproduction potential (error/boundary trigger heuristics) [Maximize]
// 4. Action count efficiency (minimizing execution steps) [Minimize]

export const ACTION_TYPES = ['NAVIGATE', 'CLICK', 'TYPE', 'SELECT', 'WAIT', 'ASSERT'];

/**
 * Generates a random exploratory browser action.
 */
export function generateRandomAction(routes = ['/', '/checkout', '/cart', '/login', '/products']) {
  const type = ACTION_TYPES[Math.floor(Math.random() * ACTION_TYPES.length)];
  const selectors = [
    '#add-to-cart',
    '.checkout-btn',
    'input[name="coupon"]',
    '#quantity',
    'button.submit',
    '.user-profile',
    '#search-input',
    'nav a.category',
    'select#shipping',
  ];
  const selector = selectors[Math.floor(Math.random() * selectors.length)];

  switch (type) {
    case 'NAVIGATE':
      return { type, url: routes[Math.floor(Math.random() * routes.length)] };
    case 'CLICK':
      return { type, selector };
    case 'TYPE':
      return {
        type,
        selector: selector.includes('input') ? selector : 'input[name="coupon"]',
        text: ['DISCOUNT20', '<script>alert(1)</script>', 'test@example.com', '123456', 'SPECIAL_PROMO'][
          Math.floor(Math.random() * 5)
        ],
      };
    case 'SELECT':
      return { type, selector: 'select#shipping', value: ['standard', 'express', 'overnight'][Math.floor(Math.random() * 3)] };
    case 'WAIT':
      return { type, durationMs: [100, 250, 500][Math.floor(Math.random() * 3)] };
    case 'ASSERT':
      return { type, selector: '.price-total', condition: 'visible' };
    default:
      return { type: 'CLICK', selector: '#add-to-cart' };
  }
}

/**
 * Evaluates the 4 objective functions for a given action sequence.
 */
export function evaluateObjectives(sequence, appModel = {}) {
  const visitedStates = new Set();
  const typeCounts = {};
  let defectScore = 0;

  let currentUrl = '/';
  visitedStates.add(currentUrl);

  for (const act of sequence) {
    typeCounts[act.type] = (typeCounts[act.type] || 0) + 1;

    if (act.type === 'NAVIGATE') {
      currentUrl = act.url || '/';
      visitedStates.add(currentUrl);
    } else if (act.type === 'CLICK') {
      const stateKey = `${currentUrl}:${act.selector}`;
      visitedStates.add(stateKey);

      // Defect heuristics: clicking submit/checkout or high-volume actions
      if (act.selector && (act.selector.includes('checkout') || act.selector.includes('submit'))) {
        defectScore += 1.5;
      }
    } else if (act.type === 'TYPE') {
      // Injection or boundary test cases
      if (act.text && (act.text.includes('<') || act.text.includes('PROMO') || act.text.length > 20)) {
        defectScore += 2.0;
      }
    }
  }

  // Objective 1: State Coverage (Number of unique state signatures visited)
  const f1_stateCoverage = visitedStates.size;

  // Objective 2: Interaction Diversity (Shannon Entropy of action types)
  const totalActions = sequence.length || 1;
  let entropy = 0;
  for (const count of Object.values(typeCounts)) {
    const p = count / totalActions;
    if (p > 0) entropy -= p * Math.log2(p);
  }
  const f2_diversity = Number(entropy.toFixed(3));

  // Objective 3: Defect Reproduction Potential
  const f3_defectPotential = Number(defectScore.toFixed(2));

  // Objective 4: Action Count Efficiency (minimization target, stored positive)
  const f4_actionCount = sequence.length;

  return {
    stateCoverage: f1_stateCoverage, // maximize
    diversity: f2_diversity,         // maximize
    defectPotential: f3_defectPotential, // maximize
    actionCount: f4_actionCount,     // minimize
  };
}

/**
 * Checks if individual A dominates individual B in Pareto sense.
 * A dominates B if A is no worse than B in all objectives and strictly better in at least one.
 */
export function dominates(a, b) {
  const aObj = a.objectives;
  const bObj = b.objectives;

  const noWorse =
    aObj.stateCoverage >= bObj.stateCoverage &&
    aObj.diversity >= bObj.diversity &&
    aObj.defectPotential >= bObj.defectPotential &&
    aObj.actionCount <= bObj.actionCount; // <= because minimize action count

  const strictlyBetter =
    aObj.stateCoverage > bObj.stateCoverage ||
    aObj.diversity > bObj.diversity ||
    aObj.defectPotential > bObj.defectPotential ||
    aObj.actionCount < bObj.actionCount;

  return noWorse && strictlyBetter;
}

/**
 * Fast Non-Dominated Sorting (Deb et al., 2002).
 */
export function fastNonDominatedSort(population) {
  const fronts = [[]];
  const dominatedSet = new Map(); // p -> Set of individuals dominated by p
  const dominationCount = new Map(); // p -> number of individuals dominating p

  for (let i = 0; i < population.length; i++) {
    const p = population[i];
    dominatedSet.set(p, []);
    dominationCount.set(p, 0);

    for (let j = 0; j < population.length; j++) {
      if (i === j) continue;
      const q = population[j];
      if (dominates(p, q)) {
        dominatedSet.get(p).push(q);
      } else if (dominates(q, p)) {
        dominationCount.set(p, dominationCount.get(p) + 1);
      }
    }

    if (dominationCount.get(p) === 0) {
      p.rank = 1;
      fronts[0].push(p);
    }
  }

  let i = 0;
  while (fronts[i] && fronts[i].length > 0) {
    const nextFront = [];
    for (const p of fronts[i]) {
      for (const q of dominatedSet.get(p)) {
        const currentCount = dominationCount.get(q) - 1;
        dominationCount.set(q, currentCount);
        if (currentCount === 0) {
          q.rank = i + 2;
          nextFront.push(q);
        }
      }
    }
    i++;
    if (nextFront.length > 0) fronts.push(nextFront);
  }

  return fronts;
}

/**
 * Calculates Crowding Distance for individuals within a front.
 */
export function calculateCrowdingDistance(front) {
  const n = front.length;
  if (n === 0) return;
  for (const p of front) p.crowdingDistance = 0;

  if (n <= 2) {
    for (const p of front) p.crowdingDistance = Infinity;
    return;
  }

  const objectiveKeys = [
    { key: 'stateCoverage', min: false },
    { key: 'diversity', min: false },
    { key: 'defectPotential', min: false },
    { key: 'actionCount', min: true },
  ];

  for (const { key } of objectiveKeys) {
    front.sort((a, b) => a.objectives[key] - b.objectives[key]);
    front[0].crowdingDistance = Infinity;
    front[n - 1].crowdingDistance = Infinity;

    const range = front[n - 1].objectives[key] - front[0].objectives[key];
    if (range > 0) {
      for (let i = 1; i < n - 1; i++) {
        front[i].crowdingDistance += (front[i + 1].objectives[key] - front[i - 1].objectives[key]) / range;
      }
    }
  }
}

/**
 * Crowded Tournament Selection.
 */
export function crowdedTournamentSelection(population) {
  const a = population[Math.floor(Math.random() * population.length)];
  const b = population[Math.floor(Math.random() * population.length)];

  if (a.rank < b.rank) return a;
  if (b.rank < a.rank) return b;
  return a.crowdingDistance >= b.crowdingDistance ? a : b;
}

/**
 * Single-Point Splice Crossover for action sequences.
 */
export function crossover(seqA, seqB) {
  if (seqA.length === 0) return [...seqB];
  if (seqB.length === 0) return [...seqA];

  const ptA = Math.floor(Math.random() * seqA.length);
  const ptB = Math.floor(Math.random() * seqB.length);

  const child = [...seqA.slice(0, ptA), ...seqB.slice(ptB)];
  return child.length > 0 ? child.slice(0, 25) : [seqA[0]];
}

/**
 * Mutation operator: inserts, deletes, or alters actions.
 */
export function mutate(sequence, routes) {
  const mutated = [...sequence];
  const rate = 0.3;

  if (Math.random() < rate && mutated.length < 20) {
    // Insertion
    const insertIdx = Math.floor(Math.random() * (mutated.length + 1));
    mutated.splice(insertIdx, 0, generateRandomAction(routes));
  }

  if (Math.random() < rate && mutated.length > 2) {
    // Deletion
    const deleteIdx = Math.floor(Math.random() * mutated.length);
    mutated.splice(deleteIdx, 1);
  }

  if (Math.random() < rate && mutated.length > 0) {
    // Parameter replacement
    const replaceIdx = Math.floor(Math.random() * mutated.length);
    mutated[replaceIdx] = generateRandomAction(routes);
  }

  return mutated;
}

/**
 * Core Algorithm Two: Runs the full NSGA-II Multi-Objective Optimization.
 */
export function runNSGA2Exploration({
  populationSize = 20,
  generations = 10,
  seedSequences = [],
  routes = ['/', '/checkout', '/cart', '/login', '/products'],
  appModel = {},
} = {}) {
  // 1. Initialize population
  let population = [];

  for (const seed of seedSequences) {
    population.push({
      sequence: [...seed],
      objectives: evaluateObjectives(seed, appModel),
      rank: 0,
      crowdingDistance: 0,
    });
  }

  while (population.length < populationSize) {
    const seqLength = Math.floor(Math.random() * 6) + 3; // 3 to 8 actions
    const seq = [];
    seq.push({ type: 'NAVIGATE', url: routes[0] || '/' });
    for (let i = 1; i < seqLength; i++) {
      seq.push(generateRandomAction(routes));
    }
    population.push({
      sequence: seq,
      objectives: evaluateObjectives(seq, appModel),
      rank: 0,
      crowdingDistance: 0,
    });
  }

  // 2. Evolution loop
  for (let gen = 0; gen < generations; gen++) {
    const fronts = fastNonDominatedSort(population);
    for (const front of fronts) {
      calculateCrowdingDistance(front);
    }

    // Create offspring via selection, crossover, mutation
    const offspring = [];
    while (offspring.length < populationSize) {
      const parentA = crowdedTournamentSelection(population);
      const parentB = crowdedTournamentSelection(population);
      const childSeq = mutate(crossover(parentA.sequence, parentB.sequence), routes);
      offspring.push({
        sequence: childSeq,
        objectives: evaluateObjectives(childSeq, appModel),
        rank: 0,
        crowdingDistance: 0,
      });
    }

    // Combine parent + offspring (2N population)
    const combined = [...population, ...offspring];
    const combinedFronts = fastNonDominatedSort(combined);

    const newPopulation = [];
    let frontIdx = 0;
    while (newPopulation.length + combinedFronts[frontIdx]?.length <= populationSize) {
      calculateCrowdingDistance(combinedFronts[frontIdx]);
      newPopulation.push(...combinedFronts[frontIdx]);
      frontIdx++;
    }

    // Fill remaining slots from the next front by crowding distance
    if (newPopulation.length < populationSize && combinedFronts[frontIdx]) {
      const remainingFront = combinedFronts[frontIdx];
      calculateCrowdingDistance(remainingFront);
      remainingFront.sort((a, b) => b.crowdingDistance - a.crowdingDistance);
      const needed = populationSize - newPopulation.length;
      newPopulation.push(...remainingFront.slice(0, needed));
    }

    population = newPopulation;
  }

  // 3. Final non-dominated sort to extract Pareto frontier (Rank 1)
  const finalFronts = fastNonDominatedSort(population);
  const paretoFrontier = finalFronts[0] || [];
  calculateCrowdingDistance(paretoFrontier);

  return {
    generationsCompleted: generations,
    populationSize,
    paretoFrontierSize: paretoFrontier.length,
    frontier: paretoFrontier.map((ind, idx) => ({
      id: `pareto-${idx + 1}`,
      objectives: ind.objectives,
      crowdingDistance: Number.isFinite(ind.crowdingDistance) ? Number(ind.crowdingDistance.toFixed(3)) : 999.0,
      sequence: ind.sequence,
    })),
  };
}
