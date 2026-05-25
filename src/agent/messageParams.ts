// Thin typed wrapper for assembling Messages API request params.
//
// The newer adaptive-thinking and output_config params are now in the SDK's
// types, but the analysis loop also supports an open `extraParams` escape hatch
// (a `Record<string, unknown>`) for forcing arbitrary request shapes from tests
// and future tunables. Merging that open record into a typed base is the one
// spot that needs an `as`, so it lives here once instead of at every call site —
// the model/max_tokens/system/tools/messages/thinking/output_config a caller
// passes through `MessageRequest` stay fully type-checked.

import type Anthropic from '@anthropic-ai/sdk';

/**
 * The typed request shape our agents build. This is just the SDK's own
 * non-streaming params type — kept as a local alias so call sites import one
 * name and the adaptive-thinking / output_config fields are checked against the
 * real SDK definitions (`ThinkingConfigParam`, `OutputConfig`).
 */
export type MessageRequest = Anthropic.MessageCreateParamsNonStreaming;

/**
 * The newer model-tuning params an agent layers on top of the base request:
 * adaptive thinking and the output_config (effort + optional json_schema
 * format). Typed against the SDK so the defaults at the call sites are checked.
 */
export type ModelTuning = Pick<MessageRequest, 'thinking' | 'output_config'>;

/**
 * Assemble final `messages.create` params from a typed `base`, the typed
 * `tuning` defaults, and an optional open `extraParams` escape hatch. When
 * `extraParams` is provided it replaces the `tuning` block entirely (matching
 * the original `...base, ...(extraParams ?? tuning)` precedence); otherwise the
 * typed defaults apply. The base always passes through.
 *
 * The lone cast localizes the unavoidable loosening from merging an untyped
 * `Record<string, unknown>` into the typed params — call sites stay cast-free.
 */
export function buildMessageParams(
  base: MessageRequest,
  tuning: ModelTuning,
  extraParams?: Record<string, unknown>
): MessageRequest {
  if (!extraParams) return { ...base, ...tuning };
  return { ...base, ...extraParams } as MessageRequest;
}
