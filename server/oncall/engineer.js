// The engineer: a tool-using agent loop, one conversation per session. It is interruptible, accepts steering while it
// works, and reaches the outside world only through the tool registry. What it writes as text is what gets spoken.
import { ENGINEER_SYSTEM, sessionBrief } from './prompts.js';

const text = (t) => ({ type: 'text', text: t });

export function createEngineer({ store, registry, provider, cfg, redactor, roleFor, describe, onSay = () => {} }) {
  const convs = new Map(); // sessionId -> { messages, inbox, running, abort, user, briefed }
  const conv = (id) => { if (!convs.has(id)) convs.set(id, { messages: [], inbox: [], running: false, abort: null, user: null, briefed: false, turnCalls: 0 }); return convs.get(id); };
  const setState = (session, state, detail = {}) => store.ephemeral(session.id, 'agent.state', { state, ...detail });

  function say(session, c, message, { final = false, kind = 'update' } = {}) {
    const clean = redactor.text(message).trim();
    if (!clean) return;
    const inc = store.incidents.current(session.id);
    store.emit(session.id, 'agent.say', { text: clean, final, kind }, inc?.id ?? null);
    onSay(store.sessions.byId(session.id), clean, { final, kind, delegationId: c.delegationId ?? null });
  }

  /** Queue something the caller said (or a server notice) and make sure the loop is running. */
  function submit(session, user, message, { source = 'voice', delegationId = null } = {}) {
    const c = conv(session.id); c.user = user;
    if (delegationId) c.delegationId = delegationId;
    c.inbox.push(source === 'notice' ? `[server notice] ${message}` : message);
    if (!c.running) run(session.id).catch((e) => store.emit(session.id, 'agent.error', { message: `Engineer loop crashed: ${e.message}` }));
    return { queued: c.running };
  }
  /** Stop the current turn now: aborts the model request and kills any running check. */
  function interrupt(sessionId, why = 'Interrupted by the user') {
    const c = convs.get(sessionId);
    if (!c?.running) return false;
    c.interrupted = why; c.abort?.abort();
    return true;
  }

  async function run(sessionId) {
    const c = conv(sessionId);
    if (c.running) return;
    c.running = true; c.turnCalls = 0; c.interrupted = null; let truncations = 0, failures = 0;
    let session = store.sessions.byId(sessionId);
    try {
      if (!provider.configured()) { say(session, c, 'The reasoning provider is not configured on this server, so I cannot investigate. An operator needs to set its credentials.', { final: true, kind: 'error' }); c.inbox.length = 0; return; }
      while (true) {
        session = store.sessions.byId(sessionId);
        if (!session || session.status !== 'active') break;
        // Deliver everything the caller said since the last model turn, after any tool results (one user message).
        if (c.inbox.length) {
          const blocks = [];
          if (!c.briefed) { blocks.push(text(sessionBrief(await describe(session, c.user)))); c.briefed = true; }
          for (const m of c.inbox.splice(0)) blocks.push(text(m));
          const last = c.messages.at(-1);
          if (last?.role === 'user' && Array.isArray(last.content)) last.content.push(...blocks); else c.messages.push({ role: 'user', content: blocks });
        } else if (c.messages.at(-1)?.role !== 'user') break; // nothing new to answer
        setState(session, 'thinking');
        c.abort = new AbortController();
        const capped = c.turnCalls >= cfg.maxToolCallsPerTurn;
        let res;
        try { res = await provider.complete({ system: ENGINEER_SYSTEM, messages: c.messages, tools: registry.definitions(session, c.user), signal: c.abort.signal, allowTools: !capped }); }
        catch (e) {
          const d = provider.describeError(e);
          if (d.aborted || c.interrupted) { stopNote(c); say(session, c, 'Stopped. Tell me how you want to proceed.', { final: true, kind: 'interrupted' }); if (c.inbox.length) { c.interrupted = null; continue; } break; }
          if (d.retryable && ++failures <= 2) { await new Promise((r) => setTimeout(r, 1500 * failures)); continue; }
          store.emit(sessionId, 'agent.error', { message: d.message });
          say(session, c, `${d.message} I have stopped; nothing further was changed.`, { final: true, kind: 'error' });
          break;
        }
        failures = 0;
        if (res.stopReason === 'refusal') { say(session, c, 'I can’t help with that request.', { final: true, kind: 'refusal' }); c.messages.push({ role: 'assistant', content: [text('(declined)')] }); break; }
        const uses = res.content.filter((b) => b.type === 'tool_use');
        if (res.stopReason === 'max_tokens' && uses.length) {
          // A truncated tool call must not run. Drop the turn and ask for smaller steps (bounded).
          if (++truncations > 2) { say(session, c, 'My responses keep getting cut off, so I have stopped rather than act on a partial instruction.', { final: true, kind: 'error' }); break; }
          c.messages.push({ role: 'assistant', content: [text('(response cut off before a tool call completed)')] }, { role: 'user', content: [text('[server notice] Your last response was cut off mid tool call and was discarded. Continue in smaller steps.')] });
          continue;
        }
        c.messages.push({ role: 'assistant', content: res.content });
        const spoken = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
        if (spoken) say(session, c, spoken, { final: !uses.length });
        if (!uses.length) { if (c.inbox.length) continue; break; }
        // Tools run one at a time: they share one worktree, and order matters.
        const results = [];
        for (const u of uses) {
          if (c.interrupted) { results.push({ type: 'tool_result', tool_use_id: u.id, is_error: true, content: 'Not run: the caller interrupted.' }); continue; }
          c.turnCalls++; setState(session, 'working', { tool: u.name });
          const r = await registry.execute({ session: store.sessions.byId(sessionId), user: c.user, signal: c.abort.signal, redactor, db: store.db }, u.name, u.input);
          results.push({ type: 'tool_result', tool_use_id: u.id, is_error: !r.ok, content: r.content });
        }
        c.messages.push({ role: 'user', content: results });
        if (c.interrupted) { stopNote(c); say(session, c, 'Stopped. Tell me how you want to proceed.', { final: true, kind: 'interrupted' }); c.interrupted = null; if (!c.inbox.length) break; continue; }
        if (c.turnCalls >= cfg.maxToolCallsPerTurn && !capped) c.messages.at(-1).content.push(text(`[server notice] You have used ${c.turnCalls} tool calls this turn, which is the limit. Tell the caller where things stand and what you need to continue.`));
      }
    } finally {
      c.running = false; c.abort = null;
      const s = store.sessions.byId(sessionId); if (s) setState(s, 'idle');
      if (c.inbox.length && s?.status === 'active') run(sessionId).catch(() => {});
    }
  }
  const stopNote = (c) => { const last = c.messages.at(-1), note = text(`[server notice] ${c.interrupted || 'Interrupted by the caller'}. Stop what you were doing and wait for their instruction.`);
    if (last?.role === 'user' && Array.isArray(last.content)) last.content.push(note); else c.messages.push({ role: 'user', content: [note] }); c.messages.push({ role: 'assistant', content: [text('Stopped.')] }); };

  return { submit, interrupt, status: (id) => { const c = convs.get(id); return { running: !!c?.running, queued: c?.inbox.length || 0, turns: c?.messages.length || 0 }; },
    idle: async (id) => { while (convs.get(id)?.running || convs.get(id)?.inbox.length) await new Promise((r) => setTimeout(r, 15)); },
    drop: (id) => { interrupt(id, 'Session ended'); convs.delete(id); registry.forget(id); } };
}
