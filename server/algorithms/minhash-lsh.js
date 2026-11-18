// MinHash & Locality-Sensitive Hashing (LSH) for Campaign Detection
// Detects near-duplicate malicious packages and typosquatting campaigns
// using AST normalization, k-shingles, MinHash signatures, and LSH banding.

import crypto from 'node:crypto';

// Large prime for hashing (Mersenne prime 2^31 - 1)
const PRIME = 2147483647;

// Generate 128 deterministic (a, b) coefficient pairs for MinHash functions
const NUM_HASHES = 128;
const HASH_COEFFICIENTS = [];
for (let i = 0; i < NUM_HASHES; i++) {
  // Deterministic seed based on index
  const a = ((i * 10007 + 1013904223) % (PRIME - 1)) + 1;
  const b = ((i * 20011 + 1664525) % PRIME);
  HASH_COEFFICIENTS.push({ a, b });
}

/**
 * Normalizes code tokens into structural representation, stripping identifiers and literals.
 */
export function normalizeTokens(code) {
  // 1. Strip comments
  const stripped = code
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/.*/g, ' ');

  // 2. Tokenize
  const tokens = [];
  const tokenRegex = /([a-zA-Z_$][a-zA-Z0-9_$]*)|(['"`](?:\\.|[^\\])*?['"`])|(\d+(?:\.\d+)?)|([{}()[\];,\.?:=+\-*/%&|^!<>~]+)/g;

  const KEYWORDS = new Set([
    'function', 'return', 'if', 'else', 'for', 'while', 'const', 'let', 'var',
    'import', 'export', 'from', 'require', 'class', 'extends', 'try', 'catch',
    'throw', 'async', 'await', 'new', 'this', 'typeof', 'instanceof',
  ]);

  let m;
  while ((m = tokenRegex.exec(stripped)) !== null) {
    if (m[1]) {
      // Identifier or Keyword
      if (KEYWORDS.has(m[1])) {
        tokens.push(`KW_${m[1]}`);
      } else {
        tokens.push('IDENT');
      }
    } else if (m[2]) {
      tokens.push('STR');
    } else if (m[3]) {
      tokens.push('NUM');
    } else if (m[4]) {
      tokens.push(`SYM_${m[4]}`);
    }
  }

  return tokens;
}

/**
 * Creates k-shingles (overlapping token n-grams) from token sequence.
 */
export function createShingles(tokens, k = 4) {
  const shingles = new Set();
  if (tokens.length < k) {
    if (tokens.length > 0) shingles.add(tokens.join('_'));
    return shingles;
  }

  for (let i = 0; i <= tokens.length - k; i++) {
    const shingle = tokens.slice(i, i + k).join('_');
    shingles.add(shingle);
  }
  return shingles;
}

/**
 * Converts string shingle to 32-bit integer hash.
 */
function hashShingle(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) % PRIME;
}

/**
 * Computes 128-element MinHash signature for a set of shingles.
 */
export function computeMinHashSignature(shingles) {
  const signature = new Array(NUM_HASHES).fill(Infinity);
  if (shingles.size === 0) return new Array(NUM_HASHES).fill(0);

  const shingleHashes = Array.from(shingles).map(hashShingle);

  for (let i = 0; i < NUM_HASHES; i++) {
    const { a, b } = HASH_COEFFICIENTS[i];
    let minVal = Infinity;
    for (const sh of shingleHashes) {
      const val = (Math.imul(a, sh) + b) % PRIME;
      if (val < minVal) minVal = val;
    }
    signature[i] = minVal;
  }

  return signature;
}

/**
 * Estimates Jaccard similarity between two MinHash signatures.
 */
export function estimateJaccardSimilarity(sigA, sigB) {
  if (sigA.length !== sigB.length || sigA.length === 0) return 0;
  let matches = 0;
  for (let i = 0; i < sigA.length; i++) {
    if (sigA[i] === sigB[i]) matches++;
  }
  return Number((matches / sigA.length).toFixed(4));
}

/**
 * Computes exact Jaccard similarity between two sets for benchmark comparison.
 */
export function exactJaccard(setA, setB) {
  if (setA.size === 0 && setB.size === 0) return 1.0;
  let intersection = 0;
  for (const item of setA) {
    if (setB.has(item)) intersection++;
  }
  const union = setA.size + setB.size - intersection;
  return union > 0 ? Number((intersection / union).toFixed(4)) : 0;
}

/**
 * Locality-Sensitive Hashing (LSH) Index for fast sub-linear near-neighbor search.
 * Uses b = 16 bands, r = 8 rows (16 * 8 = 128).
 */
export class LSHIndex {
  constructor(numBands = 16, rowsPerBand = 8) {
    this.numBands = numBands;
    this.rowsPerBand = rowsPerBand;
    this.buckets = Array.from({ length: numBands }, () => new Map());
    this.packages = new Map(); // id -> { id, name, signature, shingles }
  }

  insert(pkgId, pkgName, signature, shingles = new Set()) {
    this.packages.set(pkgId, { id: pkgId, name: pkgName, signature, shingles });

    for (let band = 0; band < this.numBands; band++) {
      const start = band * this.rowsPerBand;
      const end = start + this.rowsPerBand;
      const bandSlice = signature.slice(start, end);
      const bucketKey = bandSlice.join(',');

      const bucket = this.buckets[band];
      if (!bucket.has(bucketKey)) bucket.set(bucketKey, []);
      bucket.get(bucketKey).push(pkgId);
    }
  }

  queryCandidates(signature) {
    const candidateIds = new Set();

    for (let band = 0; band < this.numBands; band++) {
      const start = band * this.rowsPerBand;
      const end = start + this.rowsPerBand;
      const bandSlice = signature.slice(start, end);
      const bucketKey = bandSlice.join(',');

      const bucket = this.buckets[band];
      if (bucket.has(bucketKey)) {
        for (const id of bucket.get(bucketKey)) {
          candidateIds.add(id);
        }
      }
    }

    return Array.from(candidateIds);
  }

  findClusters(threshold = 0.70) {
    const visited = new Set();
    const clusters = [];

    for (const [pkgId, pkg] of this.packages.entries()) {
      if (visited.has(pkgId)) continue;

      const candidates = this.queryCandidates(pkg.signature);
      const clusterMembers = [{ ...pkg, similarity: 1.0 }];
      visited.add(pkgId);

      for (const candId of candidates) {
        if (candId === pkgId || visited.has(candId)) continue;
        const cand = this.packages.get(candId);
        const sim = estimateJaccardSimilarity(pkg.signature, cand.signature);

        if (sim >= threshold) {
          visited.add(candId);
          clusterMembers.push({ ...cand, similarity: sim });
        }
      }

      if (clusterMembers.length > 1) {
        clusters.push({
          clusterId: `campaign-${clusters.length + 1}`,
          clusterSize: clusterMembers.length,
          packages: clusterMembers.map((m) => ({ id: m.id, name: m.name, similarity: m.similarity })),
          representativeSample: Array.from(pkg.shingles).slice(0, 5),
        });
      }
    }

    return clusters;
  }
}

/**
 * High-level campaign analysis function.
 */
export function analyzePackageCampaigns(packageList = [], threshold = 0.70) {
  const index = new LSHIndex(16, 8);

  for (const pkg of packageList) {
    const tokens = normalizeTokens(pkg.code || '');
    const shingles = createShingles(tokens, 4);
    const signature = computeMinHashSignature(shingles);
    index.insert(pkg.id || pkg.name, pkg.name, signature, shingles);
  }

  const clusters = index.findClusters(threshold);

  return {
    totalPackagesIndexed: packageList.length,
    clustersFound: clusters.length,
    campaigns: clusters,
  };
}
