// Reasoning provider: Claude through the official Anthropic SDK. The engineer loop only depends on `complete()`.
import Anthropic from '@anthropic-ai/sdk';

export function createAnthropicReasoning(rcfg) {
  let client = null;
  return {
    id: 'anthropic', model: rcfg.model, configured: () => rcfg.configured,
    /**
     * One model turn. Returns Anthropic-format content blocks (text / tool_use / thinking), which the loop appends
     * back unchanged so thinking blocks stay valid. Streams so long turns do not hit HTTP timeouts.
     */
    async complete({ system, messages, tools, signal, allowTools = true }) {
      client ??= new Anthropic(); // credentials from the server environment (ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN)
      const params = {
        model: rcfg.model, max_tokens: 32000, thinking: { type: 'adaptive' }, output_config: { effort: rcfg.effort },
        cache_control: { type: 'ephemeral' }, system, messages,
        // eager_input_streaming: tool inputs are not validated by the API, so the registry validates every input itself.
        tools: tools.map((t) => ({ ...t, eager_input_streaming: true })), ...(allowTools ? {} : { tool_choice: { type: 'none' } }),
      };
      // Server-side refusal fallback is on by default (ONCALL_REASONING_FALLBACKS=0 turns it off, e.g. behind a gateway that rejects it).
      const stream = rcfg.fallbacks
        ? client.beta.messages.stream({ ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' }, { signal })
        : client.messages.stream(params, { signal });
      const msg = await stream.finalMessage();
      return { content: msg.content, stopReason: msg.stop_reason, stopDetails: msg.stop_details ?? null, usage: msg.usage, model: msg.model };
    },
    /** Map SDK errors to something the loop can act on and say out loud. */
    describeError(e) {
      if (e instanceof Anthropic.APIUserAbortError) return { aborted: true, retryable: false, message: 'Interrupted.' };
      if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) return { retryable: false, message: 'The reasoning provider rejected the server credentials.' };
      if (e instanceof Anthropic.RateLimitError) return { retryable: true, message: 'The reasoning provider is rate limiting requests.' };
      if (e instanceof Anthropic.BadRequestError) return { retryable: false, message: `The reasoning provider rejected the request: ${e.message}` };
      if (e instanceof Anthropic.APIConnectionError) return { retryable: true, message: 'The reasoning provider is unreachable.' };
      if (e instanceof Anthropic.APIError) return { retryable: (e.status ?? 500) >= 500, message: `The reasoning provider returned an error (${e.status ?? 'unknown'}).` };
      return { retryable: false, message: e?.name === 'AbortError' ? 'Interrupted.' : `Reasoning failed: ${e?.message || e}`, aborted: e?.name === 'AbortError' };
    },
  };
}
