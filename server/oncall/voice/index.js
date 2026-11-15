// Voice provider registry. The rest of the application depends only on this contract, so another realtime voice
// provider is one adapter file:
//   { id, label, transport: 'webrtc', dataChannelLabel, configured(),
//     startCall({ sdp, instructions, history, store, safetyId }) -> { providerSessionId, sdp },
//     attach(providerSessionId, handlers) -> { say, note, instruct, mute, close, detach } }
// handlers: onTranscript({speaker, delta, startMs, endMs}), onDelegation({id}), onUsage({seconds}), onMuted(bool),
//           onClosed({reason, seconds}), onError({code, message}), onState('attached' | 'reconnecting')
import { createOpenAILive } from './openai-live.js';
const FACTORIES = { 'openai-live': createOpenAILive };
export function createVoice(vcfg, opts) {
  const make = FACTORIES[vcfg.provider];
  if (!make) return { id: vcfg.provider, label: `Unknown voice provider "${vcfg.provider}"`, transport: null, configured: () => false };
  return make(vcfg, opts);
}
