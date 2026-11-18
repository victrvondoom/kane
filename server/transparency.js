// Merkle evidence transparency log (Algorithm 7), following RFC 9162 section 2.1.
//
// What it adds to the existing signed dossier: an append-only history. A verifier who holds only a checkpoint (size,
// root, signature) can check that a release event was included (inclusion proof), that a later checkpoint extends an
// earlier one without rewriting it (consistency proof), and that a dossier's payload hash is the recorded leaf.
//
// What it does NOT add: third-party timestamping (no external anchor is claimed), or a new signature scheme. Checkpoints
// are signed with the existing Ed25519 server key through keys.sign and verified with crypto.verify.
import crypto from 'node:crypto';

const sha = (...parts) => {
  const h = crypto.createHash('sha256');
  for (const p of parts) h.update(p);
  return h.digest();
};
export const EMPTY_ROOT = sha(Buffer.alloc(0));
/** RFC 9162 leaf hash: SHA-256(0x00 || data). */
export const leafHash = (data) => sha(Buffer.from([0x00]), Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8'));
/** RFC 9162 node hash: SHA-256(0x01 || left || right). */
export const nodeHash = (left, right) => sha(Buffer.from([0x01]), left, right);

/** Largest power of two strictly less than n (n >= 2). */
function splitPoint(n) {
  let k = 1;
  while (k * 2 < n) k *= 2;
  return k;
}

/** Merkle tree hash of leaf hashes lo..hi-1 (RFC 9162 MTH). */
function mth(leaves, lo, hi) {
  const n = hi - lo;
  if (n === 0) return EMPTY_ROOT;
  if (n === 1) return leaves[lo];
  const k = splitPoint(n);
  return nodeHash(mth(leaves, lo, lo + k), mth(leaves, lo + k, hi));
}

/** Append-only log of leaves. Leaves are stored as hashes; the caller keeps the original data if it needs it. */
export class MerkleLog {
  constructor(leafHashes = []) {
    this.leaves = leafHashes.map((h) => (Buffer.isBuffer(h) ? h : Buffer.from(h, 'hex')));
  }
  get size() { return this.leaves.length; }
  /** Appends the leaf for `data` and returns its index. */
  append(data) { this.leaves.push(leafHash(data)); return this.leaves.length - 1; }
  root(size = this.size) {
    if (size < 0 || size > this.size) throw new Error('size is outside the log');
    return mth(this.leaves, 0, size);
  }
  /** RFC 9162 PATH(index, D[0:size]): the audit path for leaf `index` in the tree of `size` leaves. */
  inclusionProof(index, size = this.size) {
    if (!Number.isInteger(index) || index < 0 || index >= size || size > this.size) throw new Error('index is outside the tree');
    const path = (m, lo, hi) => {
      const n = hi - lo;
      if (n === 1) return [];
      const k = splitPoint(n);
      return m < k ? [...path(m, lo, lo + k), mth(this.leaves, lo + k, hi)] : [...path(m - k, lo + k, hi), mth(this.leaves, lo, lo + k)];
    };
    return path(index, 0, size).map((h) => h.toString('hex'));
  }
  /** RFC 9162 PROOF(old, D[0:new]): proves the tree of `oldSize` is a prefix of the tree of `newSize`. */
  consistencyProof(oldSize, newSize = this.size) {
    if (!Number.isInteger(oldSize) || oldSize < 0 || oldSize > newSize || newSize > this.size) throw new Error('sizes are outside the log');
    if (oldSize === 0 || oldSize === newSize) return [];
    const sub = (m, lo, hi, b) => {
      const n = hi - lo;
      if (m === n) return b ? [] : [mth(this.leaves, lo, hi)];
      const k = splitPoint(n);
      return m <= k
        ? [...sub(m, lo, lo + k, b), mth(this.leaves, lo + k, hi)]
        : [...sub(m - k, lo + k, hi, false), mth(this.leaves, lo, lo + k)];
    };
    return sub(oldSize, 0, newSize, true).map((h) => h.toString('hex'));
  }
}

const lsb = (n) => n % 2 === 1;

/** RFC 9162 section 2.1.3.2. Uses only the leaf hash, the proof and the root. */
export function verifyInclusion({ leafHash: leaf, index, size, proof, root }) {
  if (!Number.isInteger(index) || !Number.isInteger(size) || index < 0 || index >= size) return false;
  let fn = index, sn = size - 1;
  let r = Buffer.isBuffer(leaf) ? leaf : Buffer.from(leaf, 'hex');
  for (const hex of proof) {
    if (sn === 0) return false;
    const c = Buffer.from(hex, 'hex');
    if (lsb(fn) || fn === sn) {
      r = nodeHash(c, r);
      if (!lsb(fn)) while (!lsb(fn) && fn !== 0) { fn = Math.floor(fn / 2); sn = Math.floor(sn / 2); }
    } else {
      r = nodeHash(r, c);
    }
    fn = Math.floor(fn / 2); sn = Math.floor(sn / 2);
  }
  return sn === 0 && r.equals(Buffer.isBuffer(root) ? root : Buffer.from(root, 'hex'));
}

/** RFC 9162 section 2.1.4.2. Checks that the `oldSize` tree (rootOld) is a prefix of the `newSize` tree (rootNew). */
export function verifyConsistency({ oldSize, newSize, rootOld, rootNew, proof }) {
  const ro = Buffer.isBuffer(rootOld) ? rootOld : Buffer.from(rootOld, 'hex');
  const rn = Buffer.isBuffer(rootNew) ? rootNew : Buffer.from(rootNew, 'hex');
  if (!Number.isInteger(oldSize) || !Number.isInteger(newSize) || oldSize < 0 || oldSize > newSize) return false;
  if (oldSize === 0) return proof.length === 0;
  if (oldSize === newSize) return proof.length === 0 && ro.equals(rn);
  let path = proof.map((h) => Buffer.from(h, 'hex'));
  if ((oldSize & (oldSize - 1)) === 0) path = [ro, ...path]; // an exact power of two: the old root is implicit
  let fn = oldSize - 1, sn = newSize - 1;
  while (lsb(fn)) { fn = Math.floor(fn / 2); sn = Math.floor(sn / 2); }
  let fr = path[0], sr = path[0];
  for (const c of path.slice(1)) {
    if (sn === 0) return false;
    if (lsb(fn) || fn === sn) {
      fr = nodeHash(c, fr);
      sr = nodeHash(c, sr);
      if (!lsb(fn)) while (!lsb(fn) && fn !== 0) { fn = Math.floor(fn / 2); sn = Math.floor(sn / 2); }
    } else {
      sr = nodeHash(sr, c);
    }
    fn = Math.floor(fn / 2); sn = Math.floor(sn / 2);
  }
  return sn === 0 && fr.equals(ro) && sr.equals(rn);
}

/** Canonical checkpoint text: the exact bytes that are signed. */
export const checkpointText = ({ size, root }) => `shipproof.transparency/v1\nsize: ${size}\nroot: ${root}\n`;

/** Signs the current root with the server key (keys = loadKeys(...)). */
export function checkpoint(log, keys, size = log.size) {
  const cp = { size, root: log.root(size).toString('hex') };
  return { ...cp, algorithm: 'ed25519', keyId: keys.keyId, publicKey: keys.publicKey, signature: keys.sign(checkpointText(cp)) };
}

/** Verifies a checkpoint's signature only; it does not check that the root belongs to any particular log. */
export function verifyCheckpoint(cp) {
  try {
    const ok = crypto.verify(null, Buffer.from(checkpointText(cp)), crypto.createPublicKey(cp.publicKey), Buffer.from(cp.signature, 'base64'));
    return { valid: ok, problems: ok ? [] : ['checkpoint signature is not valid for this text and key'] };
  } catch (e) {
    return { valid: false, problems: [`malformed checkpoint: ${e.message}`] };
  }
}
