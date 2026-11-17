// Reasoning provider registry. A provider implements { id, model, configured(), complete({system,messages,tools,signal,allowTools}), describeError(e) }.
import { createAnthropicReasoning } from './anthropic.js';
const FACTORIES = { anthropic: createAnthropicReasoning };
export function createReasoning(rcfg) {
  const make = FACTORIES[rcfg.provider];
  if (!make) return { id: rcfg.provider, model: rcfg.model, configured: () => false, unknown: true, complete: async () => { throw new Error(`Unknown reasoning provider "${rcfg.provider}"`); }, describeError: (e) => ({ retryable: false, message: e.message }) };
  return make(rcfg);
}
