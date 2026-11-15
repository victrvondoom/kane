// Voice provider adapter: OpenAI GPT-Live over WebRTC with client delegation.
//   * The browser's SDP offer is exchanged here, with the project API key, at POST /v1/live/sessions — the key never
//     leaves the server and the browser never talks to the provider's HTTP API.
//   * The server attaches a sideband WebSocket to the same session (…/sessions/{id}/attach) to receive transcripts
//     and delegation events and to send spoken results. Tools therefore never run in, or through, the browser.
// Docs: developers.openai.com/api/docs/guides/voice-webrtc, /live-delegation, /voice-server-controls
import crypto from 'node:crypto';

const clip = (s, n = 1500) => (s.length > n ? `${s.slice(0, n - 1)}…` : s); // appends are limited to 500 tokens each

export function createOpenAILive(vcfg, { WebSocketImpl = globalThis.WebSocket, fetchImpl = fetch } = {}) {
  const wsBase = vcfg.baseUrl.replace(/^http/, 'ws');
  return {
    id: 'openai-live', label: `OpenAI GPT-Live (${vcfg.model})`, transport: 'webrtc', dataChannelLabel: 'oai-events',
    configured: () => !!vcfg.apiKey,
    /** Start a live session from the browser's SDP offer. Returns the SDP answer and the provider session id. */
    async startCall({ sdp, instructions, history = [], store = false, safetyId }) {
      const input = history.slice(-120).map((m) => ({ type: 'message', role: m.role, content: [{ type: m.role === 'assistant' ? 'output_text' : 'input_text', text: clip(m.text, 1200) }] }));
      const body = { session: { model: vcfg.model, instructions, input, audio: { output: { voice: vcfg.voice } }, delegation: { type: 'client' }, store: !!store }, transport: { type: 'webrtc', sdp } };
      let res;
      try { res = await fetchImpl(`${vcfg.baseUrl}/v1/live/sessions`, { method: 'POST', headers: { Authorization: `Bearer ${vcfg.apiKey}`, 'Content-Type': 'application/json', ...(safetyId ? { 'OpenAI-Safety-Identifier': safetyId } : {}) }, body: JSON.stringify(body), signal: AbortSignal.timeout(20000) }); }
      catch (e) { throw Object.assign(new Error(`The voice provider is unreachable (${e.cause?.code || e.name}).`), { status: 502, code: 'voice_unreachable' }); }
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data?.session?.id || !data?.transport?.sdp) throw Object.assign(new Error(`The voice provider refused the session (${res.status}${data?.error?.code ? `, ${data.error.code}` : ''}).`), { status: res.status === 401 || res.status === 403 ? 503 : 502, code: 'voice_refused', providerMessage: data?.error?.message });
      return { providerSessionId: data.session.id, sdp: data.transport.sdp };
    },
    /** Attach the server-side control channel. Handlers receive normalized events; the returned object sends commands. */
    attach(providerSessionId, h) {
      let ws = null, closed = false, attempts = 0, closing = null; const seen = new Set(), queue = [];
      const send = (ev) => { const msg = JSON.stringify({ event_id: `sp_${crypto.randomBytes(8).toString('hex')}`, ...ev }); if (ws?.readyState === 1) ws.send(msg); else if (!closed) queue.push(msg); return !closed; };
      const open = () => {
        ws = new WebSocketImpl(`${wsBase}/v1/live/sessions/${encodeURIComponent(providerSessionId)}/attach`, { headers: { Authorization: `Bearer ${vcfg.apiKey}` } });
        ws.onopen = () => { attempts = 0; h.onState?.('attached'); for (const m of queue.splice(0)) ws.send(m); };
        ws.onmessage = (m) => {
          let ev; try { ev = JSON.parse(typeof m.data === 'string' ? m.data : Buffer.from(m.data).toString()); } catch { return; }
          // Re-attaching replays the last few seconds: act on each event id once.
          if (ev.event_id) { if (seen.has(ev.event_id)) return; seen.add(ev.event_id); if (seen.size > 5000) seen.delete(seen.values().next().value); }
          switch (ev.type) {
            case 'session.input_transcript.delta': h.onTranscript?.({ speaker: 'user', delta: ev.delta || '', startMs: ev.start_ms, endMs: ev.end_ms }); break;
            case 'session.output_transcript.delta': h.onTranscript?.({ speaker: 'agent', delta: ev.delta || '', startMs: ev.start_ms, endMs: ev.end_ms }); break;
            case 'session.delegation.created': if (ev.delegation?.target !== 'responses') h.onDelegation?.({ id: ev.delegation?.id, offsetMs: ev.offset_ms }); break;
            case 'session.usage.updated': h.onUsage?.({ seconds: ev.usage?.seconds ?? 0 }); break;
            case 'session.input_audio.muted': h.onMuted?.(true); break;
            case 'session.input_audio.unmuted': h.onMuted?.(false); break;
            case 'session.closed': closed = true; h.onClosed?.({ reason: ev.reason || 'closed', seconds: ev.usage?.seconds ?? null }); closing?.(); try { ws.close(); } catch {} break;
            case 'error': h.onError?.({ code: ev.error?.code || null, message: ev.error?.message || 'voice provider error' }); break;
          }
        };
        ws.onerror = () => {};
        ws.onclose = () => {
          if (closed) return;
          // The media connection may still be fine; only the control channel dropped. Re-attach with backoff.
          if (++attempts > 5) { closed = true; h.onClosed?.({ reason: 'control_lost', seconds: null }); return; }
          h.onState?.('reconnecting'); setTimeout(() => { if (!closed) open(); }, Math.min(500 * 2 ** attempts, 8000));
        };
      };
      open();
      return {
        /** Result or progress the voice should say aloud (it may paraphrase). */
        say: (text, delegationId = null) => send({ type: 'session.commentary.append', delegation_id: delegationId, content: clip(text) }),
        /** Quiet context: usable in later replies, not spoken now. */
        note: (text, delegationId = null) => send({ type: 'session.thinking.append', delegation_id: delegationId, content: clip(text) }),
        /** Application-authored steering of the live conversation. */
        instruct: (text) => send({ type: 'session.instructions.append', delegation_id: null, content: clip(text) }),
        mute: (on) => send({ type: on ? 'session.input_audio.mute' : 'session.input_audio.unmute' }),
        /** Graceful close: ask the provider to finalize, wait briefly for confirmation, then release the socket. */
        close: () => new Promise((resolve) => {
          if (closed) return resolve({ confirmed: true });
          const t = setTimeout(() => { closed = true; try { ws?.close(); } catch {} resolve({ confirmed: false }); }, 5000);
          closing = () => { clearTimeout(t); resolve({ confirmed: true }); };
          if (ws?.readyState === 1) ws.send(JSON.stringify({ type: 'session.close', event_id: `sp_close_${Date.now()}` })); else { clearTimeout(t); closed = true; try { ws?.close(); } catch {} resolve({ confirmed: false }); }
        }),
        /** Drop the control channel without ending the provider session (used when a replacement session takes over). */
        detach: () => { closed = true; try { ws?.close(); } catch {} },
      };
    },
  };
}
