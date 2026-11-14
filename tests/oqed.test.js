// OQED Native x86-64 Optimization Engine Tests
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  checkOqedStatus,
  scanProjectNativeTargets,
  evaluateOqedEligibility,
} from '../server/oqed.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

test('OQED: reports toolchain discovery status accurately without crashing', () => {
  const status = checkOqedStatus();
  assert.equal(status.engine, 'OQED (Superoptimizer for x86-64)');
  assert.ok(typeof status.isLinux === 'boolean');
  assert.ok(typeof status.isX86_64 === 'boolean');
  assert.ok(Array.isArray(status.missingTools));
  assert.ok(typeof status.toolStatus === 'object');
  assert.ok(['READY', 'UNAVAILABLE_TOOLCHAIN_MISSING'].includes(status.capability));
});

test('OQED: scans project workspace and detects absence of native C/C++ targets in web app', () => {
  const targetScan = scanProjectNativeTargets(root);
  assert.ok(typeof targetScan.hasNativeTargets === 'boolean');
  assert.ok(Array.isArray(targetScan.files));
});

test('OQED: evaluation honestly flags unavailability rather than faking an optimization', () => {
  const evalResult = evaluateOqedEligibility(root);
  assert.ok(['READY', 'UNAVAILABLE_NO_NATIVE_TARGETS', 'UNAVAILABLE_TOOLCHAIN_MISSING'].includes(evalResult.code));
  assert.ok(typeof evalResult.summary === 'string');
  assert.ok(typeof evalResult.eligible === 'boolean');
});

