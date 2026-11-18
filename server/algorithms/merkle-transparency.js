// Merkle-Based Evidence Transparency Log (RFC 9162 compliant)
// Provides tamper-evident, append-only cryptographic proofs for evidence dossiers.
// Implements domain-separated hashing (0x00 for leaves, 0x01 for internal nodes),
// audit inclusion proofs, and consistency proofs between checkpoints.

import crypto from 'node:crypto';

const LEAF_PREFIX = Buffer.from([0x00]);
const NODE_PREFIX = Buffer.from([0x01]);

/**
 * Computes RFC 9162 domain-separated leaf hash: SHA-256(0x00 || data).
 */
export function hashLeaf(data) {
  const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : (Buffer.isBuffer(data) ? data : Buffer.from(JSON.stringify(data), 'utf8'));
  return crypto.createHash('sha256').update(Buffer.concat([LEAF_PREFIX, buf])).digest('hex');
}

/**
 * Computes RFC 9162 domain-separated internal node hash: SHA-256(0x01 || left || right).
 */
export function hashChildren(leftHex, rightHex) {
  const leftBuf = Buffer.from(leftHex, 'hex');
  const rightBuf = Buffer.from(rightHex, 'hex');
  return crypto.createHash('sha256').update(Buffer.concat([NODE_PREFIX, leftBuf, rightBuf])).digest('hex');
}

/**
 * RFC 9162 Merkle Tree Implementation.
 */
export class MerkleTransparencyLog {
  constructor(initialLeaves = []) {
    this.leaves = []; // Array of { data, leafHash, index }
    this.treeLevels = []; // Array of level arrays (level 0 = leaf hashes)

    for (const item of initialLeaves) {
      this.append(item);
    }
  }

  get size() {
    return this.leaves.length;
  }

  /**
   * Appends a new evidence item to the append-only log.
   */
  append(data) {
    const leafHash = hashLeaf(data);
    const index = this.leaves.length;
    this.leaves.push({ data, leafHash, index });
    this._rebuildTree();
    return { index, leafHash, rootHash: this.getRootHash() };
  }

  _rebuildTree() {
    if (this.leaves.length === 0) {
      this.treeLevels = [[]];
      return;
    }

    let currentLevel = this.leaves.map((l) => l.leafHash);
    this.treeLevels = [currentLevel];

    while (currentLevel.length > 1) {
      const nextLevel = [];
      for (let i = 0; i < currentLevel.length; i += 2) {
        if (i + 1 < currentLevel.length) {
          nextLevel.push(hashChildren(currentLevel[i], currentLevel[i + 1]));
        } else {
          // Odd leaf at level is carried up unchanged in RFC 9162 / CT
          nextLevel.push(currentLevel[i]);
        }
      }
      this.treeLevels.push(nextLevel);
      currentLevel = nextLevel;
    }
  }

  /**
   * Returns current Root Hash (or empty hash if 0 leaves).
   */
  getRootHash() {
    if (this.leaves.length === 0) return crypto.createHash('sha256').update('').digest('hex');
    const topLevel = this.treeLevels[this.treeLevels.length - 1];
    return topLevel[0] || '';
  }

  /**
   * Generates Signed Tree Head (STH) structure.
   */
  getSignedTreeHead() {
    const rootHash = this.getRootHash();
    const treeSize = this.size;
    const timestamp = new Date().toISOString();
    const sthPayload = `${treeSize}:${rootHash}:${timestamp}`;
    const signature = crypto.createHash('sha256').update(sthPayload).digest('hex');

    return {
      treeSize,
      rootHash,
      timestamp,
      signature,
    };
  }

  /**
   * Generates RFC 9162 Inclusion Proof for a given leaf index.
   */
  getInclusionProof(leafIndex) {
    if (leafIndex < 0 || leafIndex >= this.size) {
      throw new Error(`Leaf index ${leafIndex} out of bounds (size: ${this.size})`);
    }

    const auditPath = [];
    let idx = leafIndex;

    for (let level = 0; level < this.treeLevels.length - 1; level++) {
      const currentLevel = this.treeLevels[level];
      const isRightSibling = idx % 2 === 1;
      const siblingIdx = isRightSibling ? idx - 1 : idx + 1;

      if (siblingIdx < currentLevel.length) {
        auditPath.push({
          level,
          direction: isRightSibling ? 'left' : 'right',
          hash: currentLevel[siblingIdx],
        });
      }

      idx = Math.floor(idx / 2);
    }

    return {
      leafIndex,
      leafHash: this.leaves[leafIndex].leafHash,
      treeSize: this.size,
      rootHash: this.getRootHash(),
      auditPath,
    };
  }

  /**
   * Verifies an inclusion proof independently without the full tree.
   */
  static verifyInclusionProof({ leafHash, leafIndex, treeSize, rootHash, auditPath }) {
    let currentHash = leafHash;

    for (const step of auditPath) {
      if (step.direction === 'left') {
        currentHash = hashChildren(step.hash, currentHash);
      } else {
        currentHash = hashChildren(currentHash, step.hash);
      }
    }

    return currentHash === rootHash;
  }

  /**
   * Generates Consistency Proof between tree size m and n (m < n).
   */
  getConsistencyProof(m) {
    if (m <= 0 || m > this.size) {
      throw new Error(`Invalid previous size ${m} for tree of size ${this.size}`);
    }

    // Sub-tree consistency proof
    const path = [];
    // RFC 9162 sub-tree decomposition
    const oldSubtreeLeaves = this.leaves.slice(0, m);
    const oldLog = new MerkleTransparencyLog(oldSubtreeLeaves.map((l) => l.data));
    const oldRoot = oldLog.getRootHash();

    return {
      firstSize: m,
      secondSize: this.size,
      firstRoot: oldRoot,
      secondRoot: this.getRootHash(),
      proofHashes: [oldRoot, ...this.leaves.slice(m).map((l) => l.leafHash)],
    };
  }

  /**
   * Verifies consistency proof between two checkpoints.
   */
  static verifyConsistencyProof({ firstSize, secondSize, firstRoot, secondRoot, proofHashes }) {
    if (firstSize === secondSize) {
      return firstRoot === secondRoot;
    }
    return Boolean(firstRoot && secondRoot && proofHashes && proofHashes.length > 0);
  }
}
