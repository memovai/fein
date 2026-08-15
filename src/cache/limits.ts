/**
 * Provider cache limits.
 *
 * These live here rather than inside the Anthropic transport because they are
 * *policy*, not wire format: the loop and the lens need to reason about them
 * when deciding where a breakpoint is worth spending, and a future provider
 * with explicit caching would consult the same table.
 *
 * Every constant here describes a rule that fails **silently**. Exceed the
 * breakpoint ceiling, fall below the minimum, or let two anchors drift beyond
 * the lookback window, and the API still returns 200, the agent still works,
 * and the only symptom is a larger bill. That is why they are constants with
 * tests rather than comments.
 */

/** Maximum explicit cache_control breakpoints per request (Anthropic). */
export const MAX_CACHE_BREAKPOINTS = 4;

/**
 * How far back a breakpoint searches for a prior cache entry, in *content
 * blocks* — not messages. One assistant turn issuing six parallel tool calls
 * is seven blocks, and the user turn carrying their results is six more, so a
 * single agentic exchange can consume most of this window.
 */
export const CACHE_LOOKBACK_BLOCKS = 20;

/**
 * Minimum cacheable prefix, in tokens, by model. A prefix shorter than this is
 * silently not cached — `cache_creation_input_tokens` comes back 0 and nothing
 * warns you.
 *
 * Note this is **not monotonic across versions**: the older Opus 4.6 has an
 * eight-times higher minimum than Opus 5. It cannot be inferred from a version
 * number, which is exactly why it needs a table.
 */
export const CACHE_MINIMUM_TOKENS: Record<string, number> = {
  "claude-opus-5": 512,
  "claude-fable-5": 512,
  "claude-mythos-5": 512,
  "claude-opus-4-8": 1024,
  "claude-sonnet-5": 1024,
  "claude-sonnet-4-6": 1024,
  "claude-sonnet-4-5": 1024,
  "claude-opus-4-7": 2048,
  "claude-opus-4-6": 4096,
  "claude-opus-4-5": 4096,
  "claude-haiku-4-5": 4096,
};

/** Conservative default for unknown models: assume the common 1024. */
export function cacheMinimumFor(model: string): number {
  return CACHE_MINIMUM_TOKENS[model] ?? 1024;
}

/**
 * Cache economics. Reads are cheap; writes carry a premium that scales with
 * TTL, so a breakpoint only pays off once the prefix beneath it has been read
 * enough times to clear break-even.
 */
export const CACHE_READ_MULTIPLIER = 0.1;
export const CACHE_WRITE_MULTIPLIER = { "5m": 1.25, "1h": 2.0 } as const;

export type CacheTtl = keyof typeof CACHE_WRITE_MULTIPLIER;

/** How many reads before a breakpoint at this TTL has paid for itself. */
export function breakEvenReads(ttl: CacheTtl): number {
  // write premium / (1 - read multiplier), rounded up.
  return Math.ceil((CACHE_WRITE_MULTIPLIER[ttl] - 1) / (1 - CACHE_READ_MULTIPLIER)) + 1;
}
