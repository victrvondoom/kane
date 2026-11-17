// Telephony adapter contract (inbound and outbound phone calls).
//
// Phone support is deliberately a separate adapter: the agent, the tool layer and the session manager do not change.
// A telephony adapter turns a phone call into the same control channel a browser call uses:
//
//   { id, configured(),
//     // Verify and parse the provider's "incoming call" webhook; return null to ignore it.
//     parseIncoming(req) -> { callId, from, to } | null,
//     // Accept the call with the live-session configuration and return the provider session id to attach to.
//     accept({ callId, instructions, history }) -> { providerSessionId },
//     reject({ callId, reason }),
//     // Place an outbound call (e.g. paging the on-call engineer) and return the provider session id.
//     dial({ to, instructions, history }) -> { providerSessionId } }
//
// The session manager then calls `voice.attach(providerSessionId, handlers)` exactly as it does for WebRTC. Caller
// identity must be mapped to a SHIPPROOF account before any tool runs (phone calls start read-only).
//
// NOT IMPLEMENTED in this release: no adapter is registered, the product exposes no phone number, and nothing in the
// UI or API claims otherwise. `status()` reports that plainly.
const ADAPTERS = {};
export function createTelephony(tcfg) {
  const make = ADAPTERS[tcfg.provider];
  if (make) return make(tcfg);
  return { id: tcfg.provider || null, configured: () => false, status: () => ({ available: false, reason: tcfg.provider ? `No telephony adapter named "${tcfg.provider}" is installed.` : 'Phone calls are not implemented in this release; browser voice only.' }) };
}
