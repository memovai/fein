import type {
  CompletionRequest,
  CompletionResult,
  ModelInfo,
  ModelPort,
  ToolDialect,
} from "../../core/types.js";

/**
 * A deterministic, network-free port.
 *
 * This exists for two reasons beyond testing. First, it lets `fein demo` show
 * the hybrid loop end-to-end on a laptop with no keys and no GPU — the shape
 * of the system is the interesting part, and it should be inspectable without
 * a bill. Second, it doubles as a *cache simulator*: it reports how many
 * message-prefix tokens it would have served from cache given the previous
 * request, so PrefixGuard and the ledger can be exercised against a provider
 * whose caching behavior we fully control.
 */
export type ScriptedHandler = (
  req: CompletionRequest,
  turn: number,
) => Partial<CompletionResult> & { text: string };

export interface ScriptedOptions {
  id: string;
  locality: "local" | "cloud";
  model?: string;
  toolDialect?: ToolDialect;
  costPerMTokIn?: number;
  costPerMTokOut?: number;
  contextWindow?: number;
  /** Simulated per-call latency, ms. */
  latencyMs?: number;
  handler: ScriptedHandler;
}

export class ScriptedPort implements ModelPort {
  readonly info: ModelInfo;
  private turn = 0;
  /** Serialized prefix of the previous request, for cache simulation. */
  private prevPrefix: string[] = [];

  constructor(private readonly opts: ScriptedOptions) {
    this.info = {
      id: opts.id,
      provider: "scripted",
      model: opts.model ?? opts.id,
      locality: opts.locality,
      toolDialect: opts.toolDialect ?? "native",
      costPerMTokIn: opts.costPerMTokIn ?? 0,
      costPerMTokOut: opts.costPerMTokOut ?? 0,
      contextWindow: opts.contextWindow ?? 128_000,
    };
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    const started = Date.now();
    const out = this.opts.handler(req, this.turn++);

    // Simulate prefix caching: count tokens in the longest common message
    // prefix with the previous call. This is exactly the quantity FE!N's
    // render monotonicity is designed to maximize.
    const prefix = [req.system, ...req.messages.map((m) => JSON.stringify(m))];
    let shared = 0;
    for (let i = 0; i < Math.min(prefix.length, this.prevPrefix.length); i++) {
      if (prefix[i] !== this.prevPrefix[i]) break;
      shared += estimateTokens(prefix[i]!);
    }
    const total = prefix.reduce((n, s) => n + estimateTokens(s), 0);
    this.prevPrefix = prefix;

    if (this.opts.latencyMs) await sleep(this.opts.latencyMs);

    return {
      text: out.text,
      toolCalls: out.toolCalls ?? [],
      usage: out.usage ?? {
        inputTokens: total - shared,
        outputTokens: estimateTokens(out.text),
        cacheReadTokens: shared,
        cacheWriteTokens: 0,
      },
      latencyMs: out.latencyMs ?? Date.now() - started,
    };
  }
}

/** ~4 chars/token. Good enough for routing and budget decisions, never for billing. */
export function estimateTokens(s: string): number {
  return Math.ceil(s.length / 4);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
