// Pure state rules for the SHIPPROOF ENGINEER workspace: no DOM, no network. Unit-tested in tests/agent-workspace.test.js.
// Authority: the server's session snapshot. The activity stream only adds events (deduplicated by server id).

export const ACTIVITY_LIMIT = 300;
export const CONTEXT_FIELD_LIMIT = 500;

export function initialState() {
  return { status: null, session: null, transcript: [], authorizations: [], engineer: { state: 'idle' }, incident: null,
    activity: [], lastId: 0, connection: 'idle', error: null };
}

/** Adds one activity event unless its server id was already seen (replays after a reconnect, duplicate delivery). */
export function applyActivity(state, ev) {
  if (!ev || ev.id == null || ev.id <= state.lastId) return { state, fresh: false };
  return { state: { ...state, lastId: ev.id, activity: [...state.activity, ev].slice(-ACTIVITY_LIMIT) }, fresh: true };
}

/** Replaces the server-owned parts of the state. The activity cursor is deliberately untouched: the stream owns it. */
export function applySnapshot(state, snap) {
  return { ...state, session: snap.session, transcript: snap.transcript || [], authorizations: snap.authorizations || [],
    engineer: snap.engineer || { state: 'idle' }, incident: snap.incident || null };
}

/** Session project identity. `null` means a general conversation with no project. */
export const projectOf = (session) => session?.projectId ?? null;
export const sameProject = (session, projectId) => projectOf(session) === (projectId ?? null);

const clip = (v, n = CONTEXT_FIELD_LIMIT) => { const s = String(v ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };

/**
 * A record the user chose to "Ask the engineer about". Only the fields the UI already shows, each clipped; the agent
 * receives identifiers and facts, never a dump of other records. The server still enforces project ownership.
 */
export function contextBlock(ctx) {
  if (!ctx) return '';
  const lines = ['[SHIPPROOF context attached by the user]', `Kind: ${clip(ctx.kind, 60)}`, `Record: ${clip(ctx.title, 200)}`];
  for (const [k, v] of Object.entries(ctx.fields || {})) if (v != null && v !== '') lines.push(`${clip(k, 40)}: ${clip(v)}`);
  lines.push('[end of context]');
  return lines.join('\n');
}

/** Message text actually sent: the attached context (if any) followed by what the user typed. */
export function composeMessage(text, ctx) {
  const body = String(text || '').trim();
  if (!body) return ''; // an attachment never travels on its own: the user must ask something
  const block = contextBlock(ctx);
  return block ? `${block}\n\n${body}` : body;
}

/** Evidence references the engineer writes in prose, e.g. "E-3". */
export const EVIDENCE_REF = /\bE-\d+\b/g;
export function evidenceRefs(text) { return [...new Set(String(text || '').match(EVIDENCE_REF) || [])]; }
