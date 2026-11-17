// The engineering tool layer. Nothing the agent does reaches a repository, a process or SHIPPROOF data except through
// `execute()` here, which enforces — in this order — the allowlist, input validation, the session's permission tier,
// the account's role, workflow gates, human authorization for production actions and a rate limit. Every call is
// written to the evidence ledger; engineering and production calls are also written to the audit trail.
import { audit } from '../../db.js';
import { TIERS, tierAllows } from '../config.js';

export class ToolError extends Error { constructor(code, message, extra = {}) { super(message); this.code = code; Object.assign(this, extra); } }

/** Small JSON-Schema subset validator (object/string/integer/number/boolean/array, enum, required, bounds). Unknown keys are rejected. */
export function validate(schema, value, at = 'input') {
  const fail = (m) => { throw new ToolError('invalid_input', `${at}: ${m}`); };
  switch (schema.type) {
    case 'object': {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('must be an object');
      for (const k of Object.keys(value)) if (!schema.properties?.[k]) fail(`unknown field "${k}"`);
      for (const k of schema.required || []) if (value[k] === undefined || value[k] === null) fail(`"${k}" is required`);
      const out = {};
      for (const [k, s] of Object.entries(schema.properties || {})) if (value[k] !== undefined && value[k] !== null) out[k] = validate(s, value[k], `${at}.${k}`);
      return out;
    }
    case 'string':
      if (typeof value !== 'string') fail('must be a string');
      if (value.includes('\0')) fail('contains a NUL byte');
      if (schema.minLength && value.trim().length < schema.minLength) fail(`must be at least ${schema.minLength} characters`);
      if (value.length > (schema.maxLength ?? 4000)) fail(`is too long (max ${schema.maxLength ?? 4000})`);
      if (schema.enum && !schema.enum.includes(value)) fail(`must be one of ${schema.enum.join(', ')}`);
      if (schema.pattern && !new RegExp(schema.pattern).test(value)) fail(`has an invalid format`);
      return value;
    case 'integer': case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value) || (schema.type === 'integer' && !Number.isInteger(value))) fail(`must be a${schema.type === 'integer' ? 'n integer' : ' number'}`);
      if (schema.minimum != null && value < schema.minimum) fail(`must be ≥ ${schema.minimum}`);
      if (schema.maximum != null && value > schema.maximum) fail(`must be ≤ ${schema.maximum}`);
      return value;
    case 'boolean': if (typeof value !== 'boolean') fail('must be true or false'); return value;
    case 'array':
      if (!Array.isArray(value)) fail('must be an array');
      if (value.length > (schema.maxItems ?? 50)) fail(`has too many items (max ${schema.maxItems ?? 50})`);
      if (schema.minItems && value.length < schema.minItems) fail(`needs at least ${schema.minItems} item(s)`);
      return value.map((v, i) => validate(schema.items, v, `${at}[${i}]`));
    default: fail('unsupported schema');
  }
}
const clip = (s, n) => (s.length > n ? `${s.slice(0, n)}\n… [truncated ${s.length - n} characters — narrow the request to see more]` : s);

export function createRegistry({ store, cfg, db, roleFor }) {
  const tools = new Map();
  const calls = new Map(); // sessionId -> timestamps
  const define = (t) => {
    if (tools.has(t.name)) throw new Error(`duplicate tool ${t.name}`);
    if (!TIERS.includes(t.tier)) throw new Error(`bad tier for ${t.name}`);
    tools.set(t.name, { input: { type: 'object', properties: {} }, ...t });
  };
  /** Tool definitions a session may see: only tools at or below both the session's level and the account's role. */
  const visible = (session, user) => {
    const role = roleFor(user);
    return [...tools.values()].filter((t) => role && tierAllows(role, t.tier) && (t.tier === 'production' ? tierAllows(session.permission_level, 'engineering') : tierAllows(session.permission_level, t.tier)));
  };
  const definitions = (session, user) => visible(session, user).map((t) => ({ name: t.name, description: `[${t.tier}] ${t.description}`, input_schema: { ...t.input, additionalProperties: false } }));

  async function execute(ctx, name, rawInput) {
    const { session, user } = ctx, t0 = Date.now();
    const tool = tools.get(name);
    let incident = store.incidents.current(session.id);
    const done = (ok, summary, body, extra = {}) => {
      const { ref } = store.evidence.add({ sessionId: session.id, incidentId: incident?.id ?? null, tool: name, tier: tool?.tier || 'read_only', input: rawInput ?? {}, ok, summary, output: body, durationMs: Date.now() - t0 });
      store.emit(session.id, 'tool', { ref, tool: name, tier: tool?.tier || 'read_only', ok, summary, durationMs: Date.now() - t0, ...extra }, incident?.id ?? null);
      if (tool && tool.tier !== 'read_only') audit(db, { userId: user.id, projectId: incident?.project_id ?? null, actor: 'oncall-agent', action: `oncall.${name}`, entity: 'oncall_incident', entityId: incident?.id ?? null,
        detail: { ok, ref, session: session.uid, summary: String(summary).slice(0, 300), ...extra } });
      return ref;
    };
    try {
      if (!tool) throw new ToolError('unknown_tool', `No such tool: ${name}`);
      const input = validate(tool.input, rawInput ?? {});
      const role = roleFor(user);
      if (session.status !== 'active') throw new ToolError('session_ended', 'This session has ended');
      if (!role || !tierAllows(role, tool.tier)) throw new ToolError('permission_denied', `Your account is not authorized for ${tool.tier.replace('_', '-')} actions.`);
      const needed = tool.tier === 'production' ? 'engineering' : tool.tier;
      if (!tierAllows(session.permission_level, needed)) throw new ToolError('permission_denied', `This session is ${session.permission_level.replace('_', '-')}. ${name} needs engineering autonomy, which only the signed-in user can grant from the call screen — it cannot be granted by voice.`);
      const recent = (calls.get(session.id) || []).filter((t) => t0 - t < cfg.toolRate.windowMs);
      if (recent.length >= cfg.toolRate.max) throw new ToolError('rate_limited', `Tool rate limit reached (${cfg.toolRate.max} calls per ${cfg.toolRate.windowMs / 60000} minutes). Pause and summarise for the user.`);
      recent.push(t0); calls.set(session.id, recent);
      if (tool.needs === 'incident' || tool.needs === 'plan' || tool.needs === 'branch') {
        if (!incident) throw new ToolError('no_incident', 'Open an incident first (incident_open).');
        if ((tool.needs === 'plan' || tool.needs === 'branch') && (!incident.diagnosis_json || !incident.plan_json)) throw new ToolError('workflow', 'Record a diagnosis (incident_diagnose) and a repair plan (incident_plan) before changing anything.');
        if (tool.needs === 'branch' && !incident.worktree) throw new ToolError('workflow', 'Create the repair branch first (eng_start_branch).');
      }
      if (tool.tier === 'production') {
        const params = tool.authorizes ? tool.authorizes(ctx, input, incident) : input;
        if (!store.authorizations.consume(session.id, name, params))
          throw new ToolError('authorization_required', `${name} is a production action. Ask for it with request_production_action; it runs only after an approver confirms it on screen.`);
      }
      const result = await tool.handler({ ...ctx, incident, tool }, input);
      incident = store.incidents.current(session.id) || incident;
      const data = result?.data ?? {};
      const body = clip(typeof data === 'string' ? data : JSON.stringify(data, null, 1), tool.maxOutput ?? 14000);
      const ref = done(true, result?.summary || `${name} completed`, body, result?.meta || {});
      try { result?.after?.(ref); } catch {}
      return { ok: true, ref, summary: result?.summary, content: `evidence_ref: ${ref}\n${ctx.redactor.text(body)}` };
    } catch (e) {
      const code = e instanceof ToolError ? e.code : (e.code && typeof e.code === 'string' ? e.code : 'tool_failed');
      const message = e instanceof ToolError || e.name === 'GitError' || code !== 'tool_failed' ? e.message : `${name} failed: ${e.message}`;
      const ref = done(false, message, JSON.stringify({ error: code, message }), { error: code });
      return { ok: false, ref, code, summary: message, content: `evidence_ref: ${ref}\nerror (${code}): ${ctx.redactor.text(message)}` };
    }
  }
  return { define, definitions, visible, execute, names: () => [...tools.keys()], get: (n) => tools.get(n), forget: (sessionId) => calls.delete(sessionId) };
}
