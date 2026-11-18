// Claude Code hook handlers. Protocol (verified against code.claude.com/docs/en/hooks):
//   stdin  : one JSON object with session_id, cwd, hook_event_name, and tool_name / tool_input for tool events
//   PreToolUse deny : stdout JSON {hookSpecificOutput:{hookEventName, permissionDecision:"deny", permissionDecisionReason}}, exit 0
//   Stop block      : exit code 2, reason on stderr (Claude continues the turn with that feedback)
//   allow           : exit 0
import path from 'node:path';
import { loadSpec, isProtected, normalizeRel } from './spec.js';
import { snapshot } from './fingerprint.js';
import { runStopGate } from './gate.js';
import { loadSession, saveSession } from './state.js';

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const OK = { exitCode: 0, stdout: '', stderr: '' };

/** Returns { exitCode, stdout, stderr }. Never throws. */
export async function handleHook(event, payload = {}) {
  const cwd = payload.cwd || process.cwd();
  const sessionId = payload.session_id || 'anonymous';
  try {
    if (event === 'UserPromptSubmit') return userPromptSubmit(cwd, sessionId);
    if (event === 'PreToolUse') return preToolUse(cwd, payload);
    if (event === 'Stop') return await stop(cwd, sessionId);
    return OK;
  } catch (e) {
    // A hook fault must never be silently treated as a pass for Stop.
    if (event === 'Stop') return { exitCode: 2, stdout: '', stderr: `SHIPPROOF completion gate error: ${e.message}. Completion is not verified.` };
    return { exitCode: 0, stdout: '', stderr: `SHIPPROOF hook warning: ${e.message}` };
  }
}

function specOrNull(cwd) {
  try { return loadSpec(cwd); } catch { return null; }
}

/** Start of a user turn: record the baseline the completion gate will compare against, and reset the block count. */
function userPromptSubmit(cwd, sessionId) {
  const baseline = snapshot(cwd, specOrNull(cwd));
  saveSession(cwd, sessionId, { sessionId, baseline, blocks: 0, turnStartedAt: new Date().toISOString(), humanRequired: null });
  return OK;
}

/** Editing a protected file is refused before it happens. Bash edits to the same files are caught at Stop. */
function preToolUse(cwd, payload) {
  if (!EDIT_TOOLS.has(payload.tool_name)) return OK;
  const input = payload.tool_input || {};
  const target = input.file_path || input.notebook_path;
  if (!target) return OK;
  const rel = normalizeRel(path.relative(cwd, path.resolve(cwd, String(target))));
  if (rel.startsWith('..') || path.isAbsolute(rel)) return OK;
  if (isProtected(rel, specOrNull(cwd))) {
    const reason = `${rel} is protected by SHIPPROOF. Acceptance criteria, gate configuration and agent settings cannot be changed by the agent. Repair the application code instead.`;
    return { exitCode: 0, stderr: '', stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }) };
  }
  return OK;
}

async function stop(cwd, sessionId) {
  const session = loadSession(cwd, sessionId);
  if (session && session.humanRequired) {
    // Already escalated in this turn: do not re-run Kane for the same state, and do not let it pass silently.
    return { exitCode: 0, stdout: '', stderr: 'SHIPPROOF: this turn was already escalated as NOT VERIFIED. A person must resolve it.' };
  }
  const d = await runStopGate({ cwd, sessionId });
  if (d.decision === 'block') return { exitCode: 2, stdout: '', stderr: `SHIPPROOF completion gate [${d.code}] (attempt ${d.blocks} of ${d.maxBlocks}).\n${d.message}` };
  if (d.decision === 'needs_human') return { exitCode: 0, stdout: '', stderr: `SHIPPROOF [${d.code}] ${d.message}` };
  return { exitCode: 0, stdout: '', stderr: d.code === 'VERIFIED' ? `SHIPPROOF: ${d.message}` : '' };
}
