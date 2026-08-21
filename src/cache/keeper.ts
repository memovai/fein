import type { CompletionRequest, ModelPort, ToolSpec } from "../core/types.js";
import type { Ledger } from "../telemetry/ledger.js";

/**
 * CacheKeeper: keep a provider's prompt cache alive across human thinking time.
 *
 * This addresses a failure mode that is invisible in benchmarks and brutal in
 * real use. Anthropic's ephemeral cache has a ~5 minute TTL, refreshed on each
 * read. Interactive agent sessions are not paced in seconds — a user reads the
 * agent's output, thinks, gets coffee, comes back eight minutes later and types
 * a follow-up. The prefix is byte-identical and the harness did everything
 * right, and the request still misses, because the cache simply expired.
 *
 * **Consider the 1-hour TTL first.** Anthropic supports `cache_control` with
 * `ttl: "1h"` (see AnthropicPort's `cacheTtl`). It costs 2x to write instead
 * of 1.25x, so break-even moves from two requests to three — but it needs no
 * heartbeats, no timers, and no spending money while the user is away. For an
 * interactive session with human-scale gaps, that is usually the better trade,
 * and it is the first thing to reach for. Heartbeating is for the case where
 * the write premium genuinely does not pay off: short sessions, or prefixes
 * re-read only a couple of times.
 *
 * The heartbeat itself uses `max_tokens: 0`, which runs prefill (writing or
 * refreshing the cache at your breakpoint) and returns immediately with empty
 * content and zero output tokens billed. That supersedes the older
 * `max_tokens: 1` trick, which billed a token and returned a reply to discard.
 *
 * The honest caveats, stated rather than buried:
 *  - Every heartbeat is a real, billed API call (the cache read, at 0.1x).
 *    This trades a small certain cost against a larger probable one. It is a
 *    bet, and it is off by default.
 *  - If the user walks away for an hour, the heartbeats are pure waste. Hence
 *    `maxRefreshes`: we bound the loss rather than warming a cache forever.
 *  - `max_tokens: 0` is rejected alongside streaming, enabled thinking, forced
 *    tool_choice, structured output formats, and inside Batches. The heartbeat
 *    request is built minimally for exactly that reason.
 *  - Providers with implicit caching (OpenAI-family) have their own eviction
 *    policy and no documented refresh-on-read guarantee, so a heartbeat there
 *    is more speculative. Enable per-provider, not globally.
 */
export interface CacheKeeperOptions {
  /**
   * The port whose cache to keep warm — or a resolver for it. A resolver is
   * the right choice whenever routing can re-point the slot between turns
   * (an epoch restart lands on a different port): a heartbeat sent to the
   * *previous* port warms a cache nobody will read again, and replays the new
   * port's reasoning blocks to a model that will reject them.
   */
  port: ModelPort | (() => ModelPort);
  /** How often to refresh, ms. Should be comfortably under the provider TTL. */
  intervalMs?: number;
  /** Stop after this many refreshes; the user has clearly gone away. */
  maxRefreshes?: number;
  ledger?: Ledger;
  onRefresh?: (n: number, cacheReadTokens: number) => void;
}

export class CacheKeeper {
  private timer: NodeJS.Timeout | undefined;
  private refreshes = 0;
  private request: CompletionRequest | undefined;

  constructor(private readonly opts: CacheKeeperOptions) {}

  /**
   * Record the exact request whose prefix we want to keep warm. Must be the
   * real request, not a reconstruction: a heartbeat with a different prefix
   * warms a cache entry nobody will ever read, and may evict the one we
   * actually wanted.
   */
  arm(request: CompletionRequest, tools?: ToolSpec[]): void {
    this.request = { ...request, ...(tools ? { tools } : {}) };
  }

  start(): void {
    if (!this.request || this.timer) return;
    const interval = this.opts.intervalMs ?? 240_000; // 4 min, under a 5 min TTL
    this.timer = setInterval(() => void this.refresh(), interval);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Call when the user acts: real traffic refreshes the cache for free. */
  touch(): void {
    this.refreshes = 0;
    this.stop();
  }

  private async refresh(): Promise<void> {
    const req = this.request;
    if (!req) return;
    if (this.refreshes >= (this.opts.maxRefreshes ?? 5)) {
      this.stop();
      return;
    }
    this.refreshes++;
    try {
      const port = typeof this.opts.port === "function" ? this.opts.port() : this.opts.port;
      // maxTokens 0: run prefill, refresh the cache, bill no output tokens.
      const result = await port.complete({ ...req, maxTokens: 0, temperature: 0 });
      this.opts.ledger?.record("think", port.info, result);
      this.opts.onRefresh?.(this.refreshes, result.usage.cacheReadTokens);
    } catch {
      // A failed heartbeat is not worth surfacing or retrying; the next real
      // request will simply pay full price. Silence is the correct behavior.
      this.stop();
    }
  }
}
