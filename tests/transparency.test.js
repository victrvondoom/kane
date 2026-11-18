// Algorithm 7 — Merkle evidence transparency (RFC 9162 section 2.1). Exhaustive small-tree checks plus tamper cases.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { MerkleLog, leafHash, nodeHash, verifyInclusion, verifyConsistency, checkpoint, verifyCheckpoint, EMPTY_ROOT } from '../server/transparency.js';
import { loadKeys } from '../server/keys.js';

const entries = (n) => Array.from({ length: n }, (_, i) => `release-event-${i}`);
const logOf = (n) => { const log = new MerkleLog(); for (const e of entries(n)) log.append(e); return log; };

test('empty tree and single-leaf roots follow the RFC definitions', () => {
  assert.equal(new MerkleLog().root(0).toString('hex'), crypto.createHash('sha256').update('').digest('hex'));
  const one = logOf(1);
  assert.equal(one.root().toString('hex'), leafHash('release-event-0').toString('hex'));
  assert.ok(EMPTY_ROOT.equals(new MerkleLog().root(0)));
});

test('three leaves: the split is at the largest power of two below n (k = 2 here)', () => {
  const log = logOf(3);
  const l = entries(3).map(leafHash);
  assert.ok(log.root().equals(nodeHash(nodeHash(l[0], l[1]), l[2])), 'left subtree holds 2 leaves, right holds 1');
  assert.ok(log.root(2).equals(nodeHash(l[0], l[1])));
});

test('domain separation: a leaf and a node cannot collide on the same bytes', () => {
  const a = leafHash('x'), b = leafHash('y');
  assert.notEqual(nodeHash(a, b).toString('hex'), leafHash(Buffer.concat([a, b])).toString('hex'));
});

test('every inclusion proof verifies for every size and index up to 40 leaves', () => {
  for (let n = 1; n <= 40; n++) {
    const log = logOf(n);
    const root = log.root().toString('hex');
    for (let i = 0; i < n; i++) {
      const proof = log.inclusionProof(i);
      assert.ok(verifyInclusion({ leafHash: leafHash(`release-event-${i}`), index: i, size: n, proof, root }), `n=${n} i=${i}`);
    }
  }
});

test('an inclusion proof fails for a different leaf, index, root or altered proof', () => {
  const log = logOf(13);
  const root = log.root().toString('hex');
  const proof = log.inclusionProof(5);
  const lh = leafHash('release-event-5');
  assert.equal(verifyInclusion({ leafHash: lh, index: 5, size: 13, proof, root }), true);
  assert.equal(verifyInclusion({ leafHash: leafHash('forged'), index: 5, size: 13, proof, root }), false);
  assert.equal(verifyInclusion({ leafHash: lh, index: 6, size: 13, proof, root }), false);
  assert.equal(verifyInclusion({ leafHash: lh, index: 5, size: 13, proof, root: logOf(12).root().toString('hex') }), false);
  const bad = [...proof]; bad[0] = crypto.randomBytes(32).toString('hex');
  assert.equal(verifyInclusion({ leafHash: lh, index: 5, size: 13, proof: bad, root }), false);
  assert.equal(verifyInclusion({ leafHash: lh, index: 13, size: 13, proof, root }), false, 'index outside the tree');
});

test('every consistency proof verifies for every pair of sizes up to 40 leaves', () => {
  for (let n = 1; n <= 40; n++) {
    const log = logOf(n);
    for (let m = 1; m <= n; m++) {
      const proof = log.consistencyProof(m, n);
      assert.ok(verifyConsistency({ oldSize: m, newSize: n, rootOld: log.root(m), rootNew: log.root(n), proof }), `m=${m} n=${n}`);
    }
  }
});

test('a rewritten history cannot be proven consistent with an earlier checkpoint', () => {
  const honest = logOf(20);
  const rewritten = logOf(20);
  rewritten.leaves[7] = leafHash('altered after the fact');
  const oldRoot = honest.root(9).toString('hex');
  const newRoot = rewritten.root().toString('hex');
  const proof = rewritten.consistencyProof(9, 20);
  assert.equal(verifyConsistency({ oldSize: 9, newSize: 20, rootOld: oldRoot, rootNew: newRoot, proof }), false);
  // An honest extension of the same history does verify
  const extended = logOf(25);
  assert.equal(verifyConsistency({ oldSize: 9, newSize: 25, rootOld: honest.root(9), rootNew: extended.root(), proof: extended.consistencyProof(9, 25) }), true);
});

test('consistency rejects a reversed size pair and a changed old root', () => {
  const log = logOf(10);
  assert.equal(verifyConsistency({ oldSize: 10, newSize: 4, rootOld: log.root(10), rootNew: log.root(4), proof: [] }), false);
  const proof = log.consistencyProof(4, 10);
  const otherHistory = new MerkleLog();
  for (const e of ['a', 'b', 'c', 'd']) otherHistory.append(e);
  assert.equal(verifyConsistency({ oldSize: 4, newSize: 10, rootOld: otherHistory.root(), rootNew: log.root(), proof }), false);
});

test('inclusion proofs grow logarithmically with the tree', () => {
  const log = logOf(1000);
  for (const i of [0, 1, 499, 999]) assert.ok(log.inclusionProof(i).length <= Math.ceil(Math.log2(1000)), `index ${i}`);
});

test('checkpoints are signed with the existing server key and fail when any field changes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-transparency-'));
  try {
    const keys = loadKeys(dir);
    const log = logOf(7);
    const cp = checkpoint(log, keys);
    assert.equal(cp.keyId, keys.keyId);
    assert.deepEqual(verifyCheckpoint(cp), { valid: true, problems: [] });
    assert.equal(verifyCheckpoint({ ...cp, size: 8 }).valid, false);
    assert.equal(verifyCheckpoint({ ...cp, root: logOf(6).root().toString('hex') }).valid, false);
    assert.equal(verifyCheckpoint({ ...cp, signature: 'AAAA' }).valid, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('invalid requests are rejected', () => {
  const log = logOf(3);
  assert.throws(() => log.inclusionProof(3));
  assert.throws(() => log.consistencyProof(4, 3));
  assert.throws(() => log.root(4));
});
