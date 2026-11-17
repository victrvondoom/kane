// Unit tests for the SHIPPROOF ENGINEER state rules (public/agent-state.js): activity dedupe and replay, snapshot
// authority, project identity, and the structured context attached to a message. Pure functions, no browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as S from '../public/agent-state.js';

const ev = (id, kind = 'tool', payload = {}) => ({ id, kind, payload, ts: '2026-11-17T10:00:00.000Z' });

test('activity: each server event id is applied once, even when replayed after a reconnect', () => {
  let st = S.initialState();
  for (const e of [ev(1), ev(2), ev(3)]) st = S.applyActivity(st, e).state;
  // The browser reconnects with Last-Event-ID and the server replays from the start: nothing is duplicated.
  const replay = [ev(1), ev(2), ev(3), ev(4)];
  const fresh = replay.map((e) => S.applyActivity(st, e)).filter((r) => r.fresh);
  assert.equal(fresh.length, 1, 'only the genuinely new event is fresh');
  st = S.applyActivity(st, ev(4)).state;
  assert.deepEqual(st.activity.map((e) => e.id), [1, 2, 3, 4]);
  assert.equal(st.lastId, 4);
});

test('activity: a duplicate delivery of the same event never changes state', () => {
  const st = S.applyActivity(S.initialState(), ev(7)).state;
  const again = S.applyActivity(st, ev(7));
  assert.equal(again.fresh, false);
  assert.equal(again.state, st);
});

test('activity: events without a server id (ephemeral) are ignored by the activity log', () => {
  const r = S.applyActivity(S.initialState(), { id: null, kind: 'caption', payload: {} });
  assert.equal(r.fresh, false);
  assert.equal(r.state.activity.length, 0);
});

test('activity: the log is bounded', () => {
  let st = S.initialState();
  for (let i = 1; i <= S.ACTIVITY_LIMIT + 25; i++) st = S.applyActivity(st, ev(i)).state;
  assert.equal(st.activity.length, S.ACTIVITY_LIMIT);
  assert.equal(st.activity[0].id, 26);
  assert.equal(st.lastId, S.ACTIVITY_LIMIT + 25);
});

test('snapshot: replaces the server-owned parts and never moves the stream cursor', () => {
  let st = S.applyActivity(S.initialState(), ev(5)).state;
  const next = S.applySnapshot(st, { session: { id: 'abc', status: 'active' }, transcript: [{ id: 1, text: 'hi' }], authorizations: [], engineer: { state: 'thinking' }, incident: null, lastEventId: 99 });
  assert.equal(next.session.id, 'abc');
  assert.equal(next.transcript.length, 1);
  assert.equal(next.engineer.state, 'thinking');
  assert.equal(next.lastId, 5, 'the snapshot must not skip events the stream has not delivered yet');
  assert.equal(next.activity.length, 1);
});

test('project identity: a conversation is compared by its own project, null means general', () => {
  assert.equal(S.projectOf({ projectId: 4 }), 4);
  assert.equal(S.projectOf({ projectId: null }), null);
  assert.equal(S.projectOf(null), null);
  assert.equal(S.sameProject({ projectId: 4 }, 4), true);
  assert.equal(S.sameProject({ projectId: 4 }, 5), false, 'a different project must trigger the replace confirmation');
  assert.equal(S.sameProject({ projectId: null }, null), true);
  assert.equal(S.sameProject({ projectId: null }, 2), false);
});

test('context: a record is attached as labelled fields, clipped, with no empty values', () => {
  const block = S.contextBlock({ kind: 'repair task', title: 'RT-3 · AC-007', fields: { criterion: 'Checkout total is correct', expected: '', observed: 'x'.repeat(900), diagnosis: null } });
  const lines = block.split('\n');
  assert.equal(lines[0], '[SHIPPROOF context attached by the user]');
  assert.equal(lines[1], 'Kind: repair task');
  assert.equal(lines[2], 'Record: RT-3 · AC-007');
  assert.ok(lines.includes('criterion: Checkout total is correct'));
  assert.ok(!lines.some((l) => l.startsWith('expected:')), 'empty fields are omitted');
  assert.ok(!lines.some((l) => l.startsWith('diagnosis:')), 'null fields are omitted');
  const observed = lines.find((l) => l.startsWith('observed: '));
  assert.ok(observed.length <= 'observed: '.length + S.CONTEXT_FIELD_LIMIT, 'long values are clipped');
  assert.equal(lines.at(-1), '[end of context]');
});

test('context: no context means no block; the typed text is sent unchanged', () => {
  assert.equal(S.contextBlock(null), '');
  assert.equal(S.composeMessage('  why did it fail?  ', null), 'why did it fail?');
});

test('context: the attached block precedes the typed text; a block alone is never sent', () => {
  const ctx = { kind: 'incident', title: '#4 Checkout down', fields: { status: 'open' } };
  const msg = S.composeMessage('Explain the root cause.', ctx);
  assert.ok(msg.startsWith('[SHIPPROOF context attached by the user]'));
  assert.ok(msg.endsWith('Explain the root cause.'));
  assert.equal(S.composeMessage('   ', ctx), '', 'an attachment without a question sends nothing');
});

test('evidence references in engineer prose are found once each, in order', () => {
  assert.deepEqual(S.evidenceRefs('Checked E-1 and E-12, then E-1 again. Not E-x or XE-3.'), ['E-1', 'E-12']);
  assert.deepEqual(S.evidenceRefs(''), []);
  assert.deepEqual(S.evidenceRefs(undefined), []);
});
