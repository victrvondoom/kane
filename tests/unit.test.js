import test from 'node:test';
import assert from 'node:assert/strict';
import { decompose, categorize, textHash, formatKey } from '../server/requirements.js';
import { classify, buildObjective, redact, failingStep } from '../server/kane.js';
import { releaseGate } from '../server/gate.js';
import { calcDiscount, cartTotals } from '../demo-app/pricing.js';

test('decompose: bullets, sentences and compound capabilities become atomic criteria', () => {
  const c = decompose(`- A user can register an account, log in again and add items to the cart.\n2. The cart total updates. Coupon SAVE10 gives 10% off.\n\n# Heading\n- The cart total updates.`);
  assert.deepEqual(c.map((x) => x.text), [
    'A user can register an account.', 'A user can log in again.', 'A user can add items to the cart.',
    'The cart total updates.', 'Coupon SAVE10 gives 10% off.']);
  assert.ok(c.every((x) => x.mandatory));
});
test('decompose keeps prices and single statements intact', () => {
  const c = decompose('After applying SAVE10 to an $80.00 cart, the total shows $72.00.');
  assert.equal(c.length, 1);
  assert.match(c[0].text, /\$80\.00 cart, the total shows \$72\.00\./);
});
test('categorize', () => {
  assert.equal(categorize('The order remains listed after reloading the page'), 'persistence');
  assert.equal(categorize('The layout is responsive at mobile width'), 'visual');
  assert.equal(categorize('A user can add a product to the cart'), 'functional');
});
test('stable ids and text hash', () => {
  assert.equal(formatKey(7), 'AC-007');
  assert.equal(textHash('Total  shows $72.00'), textHash('total shows $72.00 '));
  assert.notEqual(textHash('Total shows $72.00'), textHash('Total shows $80.00'));
});

const end = (status) => ({ type: 'run_end', status });
test('classify: only exit 0 + passing run_end is a pass', () => {
  assert.equal(classify({ exitCode: 0, runEnd: end('passed') }).status, 'passed');
  assert.equal(classify({ exitCode: 1, runEnd: end('failed') }).status, 'failed');
});
test('classify: nothing ambiguous is ever a pass', () => {
  assert.deepEqual(pick(classify({ exitCode: 0, runEnd: null })), ['error', 'did_not_start']);
  assert.deepEqual(pick(classify({ exitCode: 1, runEnd: null, stderr: 'Not authenticated. Run: kane-cli login --oauth' })), ['error', 'auth']);
  assert.deepEqual(pick(classify({ exitCode: 2, runEnd: null })), ['error', 'did_not_start']);
  assert.deepEqual(pick(classify({ exitCode: 3, runEnd: end('timeout') })), ['timeout', 'timeout']);
  assert.deepEqual(pick(classify({ exitCode: null, signal: 'SIGKILL', timedOut: true })), ['timeout', 'timeout']);
  assert.deepEqual(pick(classify({ exitCode: 0, runEnd: end('failed') })), ['error', 'inconsistent']);
  assert.deepEqual(pick(classify({ exitCode: 1, runEnd: end('passed') })), ['error', 'inconsistent']);
  assert.deepEqual(pick(classify({ spawnError: Object.assign(new Error('x'), { code: 'ENOENT' }) })), ['error', 'kane_not_installed']);
  assert.deepEqual(pick(classify({ cancelled: true, exitCode: null })), ['cancelled', 'cancelled']);
});
const pick = (v) => [v.status, v.errorKind];

test('objective embeds the criterion verbatim; secrets are redacted; failing step extracted', () => {
  const o = buildObjective({ appUrl: 'http://x/', context: 'Use test data.', criterionText: 'Total shows $72.00.' });
  assert.ok(o.startsWith('Go to http://x/.') && o.includes('Total shows $72.00.') && o.includes('Use test data.'));
  assert.equal(redact('key=abcd1234 ok', ['abcd1234']), 'key=«redacted» ok');
  assert.deepEqual(failingStep([{ step: 1, status: 'done' }, { step: 2, status: 'failed', remark: 'nope' }]), { step: 2, remark: 'nope' });
});

const c = (status, mandatory = true, extra = {}) => ({ key: 'AC-001', status, mandatory, latest: status === 'untested' ? null : { status, error_kind: 'auth' }, ...extra });
test('release gate is strict', () => {
  assert.equal(releaseGate([]).verdict, 'unverified');
  assert.equal(releaseGate([c('verified'), c('verified')]).verdict, 'verified');
  assert.equal(releaseGate([c('verified'), c('untested')]).verdict, 'unverified');
  assert.equal(releaseGate([c('verified'), c('blocked')]).verdict, 'unverified');
  assert.equal(releaseGate([c('verified'), c('failed')]).verdict, 'blocked');
  assert.equal(releaseGate([c('verified'), c('failed', false)]).verdict, 'verified'); // optional failures are reported, not blocking
  assert.equal(releaseGate([c('verified', false)]).verdict, 'unverified'); // no mandatory criteria -> cannot verify
});

test('demo store: the unit-level discount maths is correct (and still misses the shipped bug)', () => {
  // This is the point of the demo: this unit test passes on the buggy build,
  // while a real user sees the wrong total. Only the browser check catches it.
  assert.equal(calcDiscount(8000, 'SAVE10'), 800);
  assert.equal(calcDiscount(8000, 'NOPE'), 0);
  assert.equal(cartTotals([{ id: 'trail-backpack', qty: 1 }], null).subtotal, 8000);
});
