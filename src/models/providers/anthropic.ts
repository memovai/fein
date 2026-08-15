import { readErrorBody } from "./http.js";
import { CACHE_LOOKBACK_BLOCKS, MAX_CACHE_BREAKPOINTS, type CacheTtl } from "../../cache/limits.js";
import type {
  Reasoning,
  ThinkingLevel,
  ChatMessage,
  CompletionRequest,
  CompletionResult,
  ModelInfo,
  ModelPort,
  ToolCall,
  ToolSpec,
} from "../../core/types.js";

/**
 * Anthropic Messages provider.
 *
 * Anthropic is the one major provider with *explicit* prompt caching: you mark
 * up to 4 breakpoints with cache_control, and everything above the deepest
 * matching breakpoint is served from cache. That makes it the provider where
 * a harness can actually engineer cache behavior instead of praying for it,
 * and it drives the rules FE!N follows:
 *
 *  1. Anchor placement is stable across turns. Anchors go after the system
 *     prompt, after the tool block, and on settled history — never on a
 *     position that shifts every turn, because a moved breakpoint writes a
 *     new cache entry instead of reading the old one.
 *  2. Cache writes cost 1.25x (5-minute TTL) or 2x (1-hour TTL); reads cost
 *     0.1x. Break-even is two requests at 5m, three at 1h. So a breakpoint
 *     only pays off if the prefix beneath it survives that long, and the
 *     ledger tracks realized savings so this stays a measured claim.
 *  3. Each breakpoint searches backward at most 20 content blocks for a prior
 *     cache entry. A single agentic turn with many parallel tool calls can
 *     easily emit more than 20 blocks, which silently puts the previous
 *     turn's entry out of reach. See placeMessageAnchors below — this is the
 *     failure mode most likely to make a "correct" harness quietly miss.
 *  4. Prefixes below the model's minimum (512–4096 tokens depending on model)
 *     do not cache at all, with no error. We surface that rather than let it
 *     look like a harness bug.
 */



export interface AnthropicOptions {
  id: string;
  model: string;
  apiKey?: string;
  baseUrl?: string;
  contextWindow?: number;
  costPerMTokIn?: number;
  costPerMTokOut?: number;
  /** Emit cache_control breakpoints. Default true. */
  caching?: boolean;
  /**
   * Cache TTL. "5m" (default) costs 1.25x to write; "1h" costs 2x but
   * survives human thinking time without a heartbeat — usually the better
   * trade for interactive sessions with gaps. See CacheKeeper.
   */
  cacheTtl?: CacheTtl;
  version?: string;
}

export class AnthropicPort implements ModelPort {
  readonly info: ModelInfo;

  constructor(private readonly opts: AnthropicOptions) {
    this.info = {
      id: opts.id,
      provider: "anthropic",
      model: opts.model,
      locality: "cloud",
      toolDialect: "native",
      costPerMTokIn: opts.costPerMTokIn ?? 0,
      costPerMTokOut: opts.costPerMTokOut ?? 0,
      contextWindow: opts.contextWindow ?? 200_000,
    };
  }

  async complete(req: CompletionRequest, signal?: AbortSignal): Promise<CompletionResult> {
    const started = Date.now();
    const caching = this.opts.caching !== false;
    const anchors = new Set(req.cacheAnchors ?? ["system", "tools", "lastMessage"]);
    const ttl = this.opts.cacheTtl ?? "5m";
    const cc = () =>
      ttl === "1h"
        ? { type: "ephemeral" as const, ttl: "1h" }
        : { type: "ephemeral" as const };

    const useSystem = caching && anchors.has("system");
    const useTools = caching && anchors.has("tools") && (req.tools?.length ?? 0) > 0;

    const system = useSystem
      ? [{ type: "text", text: req.system, cache_control: cc() }]
      : [{ type: "text", text: req.system }];

    const tools = (req.tools ?? []).map((t, i, arr) =>
      toAnthropicTool(t, useTools && i === arr.length - 1, cc()),
    );

    // 4 breakpoints total. Whatever system/tools don't claim goes to messages,
    // where the 20-block lookback constraint actually bites.
    const messageBudget = MAX_CACHE_BREAKPOINTS - (useSystem ? 1 : 0) - (useTools ? 1 : 0);
    const messages = toAnthropicMessages(
      req.messages,
      caching && anchors.has("lastMessage") ? messageBudget : 0,
      cc(),
    );

    // Mid-conversation tool changes are beta-gated. Send the flag only when the
    // conversation actually contains one, so ordinary requests stay on the GA
    // path — and so the header itself never becomes a varying prefix input.
    const betas: string[] = [];
    if (req.messages.some((m) => m.role === "system" && m.toolChanges?.length)) {
      betas.push("mid-conversation-tool-changes-2026-07-01");
    }

    const res = await fetch(
      `${(this.opts.baseUrl ?? "https://api.anthropic.com").replace(/\/$/, "")}/v1/messages`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "anthropic-version": this.opts.version ?? "2023-06-01",
          ...(betas.length ? { "anthropic-beta": betas.join(",") } : {}),
          ...(this.opts.apiKey ? { "x-api-key": this.opts.apiKey } : {}),
        },
        body: JSON.stringify({
          model: this.opts.model,
          system,
          messages,
          ...(tools.length ? { tools } : {}),
          max_tokens: req.maxTokens ?? 4096,
          ...thinkingParams(req.thinking),
          ...(req.stop?.length ? { stop_sequences: req.stop } : {}),
        }),
        signal: signal ?? null,
      },
    );

    if (!res.ok) {
      throw new Error(`${this.info.id}: HTTP ${res.status} ${await readErrorBody(res)}`);
    }
    const json = (await res.json()) as AnthropicResponse;

    let text = "";
    const toolCalls: ToolCall[] = [];
    const reasoning: Reasoning[] = [];
    for (const block of json.content ?? []) {
      if (block.type === "thinking" || block.type === "redacted_thinking") {
        // Kept whole. These blocks are signed, and the provider requires them
        // echoed back unchanged on the next request — so the block itself is
        // the payload, and the readable summary is only a view of it.
        reasoning.push({ kind: "opaque", text: block.thinking ?? "", raw: block });
      } else if (block.type === "text") text += block.text ?? "";
      else if (block.type === "tool_use") {
        toolCalls.push({
          id: block.id ?? `call_${toolCalls.length}`,
          name: block.name ?? "",
          args: (block.input as Record<string, unknown>) ?? {},
        });
      }
    }

    return {
      text,
      toolCalls,
      ...(reasoning.length ? { reasoning } : {}),
      usage: {
        inputTokens: json.usage?.input_tokens ?? 0,
        outputTokens: json.usage?.output_tokens ?? 0,
        cacheReadTokens: json.usage?.cache_read_input_tokens ?? 0,
        cacheWriteTokens: json.usage?.cache_creation_input_tokens ?? 0,
      },
      latencyMs: Date.now() - started,
      raw: json,
    };
  }
}

/**
 * Map FE!N's `ThinkingLevel` onto the provider's controls.
 *
 * Two things worth stating. Adaptive thinking replaces the old fixed
 * `budget_tokens` dial, so we express depth as effort rather than a token count.
 * And `temperature` is omitted entirely rather than defaulted to 0 — current
 * models reject sampling parameters, and a harness that sends one by habit
 * fails on the newest model it supports.
 *
 * `display: "summarized"` is requested because reasoning we cannot read is
 * reasoning we cannot replay into a ReAct transcript, log, or trace. The raw
 * chain of thought is never returned by any model; a summary is what exists.
 */
function thinkingParams(level: ThinkingLevel | undefined): Record<string, unknown> {
  if (!level || level === "off") return { thinking: { type: "disabled" } };
  const effort = level === "max" ? "max" : level;
  return {
    thinking: { type: "adaptive", display: "summarized" },
    output_config: { effort },
  };
}

interface AnthropicResponse {
  content?: Array<{
    type: string;
    text?: string;
    id?: string;
    name?: string;
    input?: unknown;
    thinking?: string;
  }>;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
}

function toAnthropicTool(t: ToolSpec, anchor: boolean, cc: object) {
  return {
    name: t.name,
    description: t.description,
    input_schema: t.parameters,
    ...(t.deferLoading ? { defer_loading: true } : {}),
    ...(anchor ? { cache_control: cc } : {}),
  };
}

/**
 * Choose which messages get a cache breakpoint.
 *
 * Two constraints fight each other here, and getting the fight wrong is the
 * single most common way a carefully-built agent harness silently stops
 * hitting cache:
 *
 *  - **Stability.** An anchor must land on settled history. Anchoring the
 *    literal last message every turn writes a fresh entry (at 1.25x) every
 *    turn and reads almost nothing. So the primary anchor goes one message
 *    back from the edge.
 *
 *  - **Reach.** A breakpoint searches backward at most 20 *content blocks*
 *    for a prior entry. Blocks, not messages: one assistant turn issuing six
 *    parallel tool calls is seven blocks, and the user turn carrying their
 *    six results is six more. Two such turns and the previous anchor is out
 *    of reach — the breakpoint finds nothing, and you pay full price for the
 *    whole conversation with no error and no warning.
 *
 * So we walk backward from the settled edge and drop an additional anchor
 * every time the running block count approaches the lookback limit, spending
 * the breakpoint budget left over after system and tools. Anchors are placed
 * at *block-count* positions rather than message counts, so the placement is
 * stable for a given transcript prefix — which is what keeps it cache-safe.
 */
function planAnchors(messages: ChatMessage[], budget: number): Set<number> {
  const anchors = new Set<number>();
  if (budget <= 0 || messages.length < 2) return anchors;

  // Settled edge: one message back from the moving end.
  const settled = messages.length - 2;
  anchors.add(settled);

  // Walk backward, adding an anchor whenever we are about to exceed the
  // lookback window, until the budget is spent.
  let blocks = 0;
  for (let i = settled - 1; i >= 0 && anchors.size < budget; i--) {
    blocks += blockCount(messages[i]!);
    if (blocks >= CACHE_LOOKBACK_BLOCKS - 2) {
      anchors.add(i);
      blocks = 0;
    }
  }
  return anchors;
}

function blockCount(m: ChatMessage): number {
  switch (m.role) {
    case "system":
    case "user":
      return 1;
    case "assistant":
      return Math.max(1, (m.content ? 1 : 0) + (m.toolCalls?.length ?? 0));
    case "tool":
      return Math.max(1, m.results.length);
  }
}

function toAnthropicMessages(
  messages: ChatMessage[],
  anchorBudget: number,
  cc: object,
): unknown[] {
  const out: unknown[] = [];
  const anchors = planAnchors(messages, anchorBudget);

  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!;
    const anchor = anchors.has(i);
    switch (m.role) {
      case "system": {
        // A system-role message inside `messages` — the cache-preserving way
        // to add operator context or change the tool set mid-conversation.
        // Editing top-level `system` or `tools` instead would rewrite the very
        // front of the prefix and discard the entire cached conversation.
        if (m.toolChanges?.length) {
          out.push({
            role: "system",
            content: m.toolChanges.map((c) => ({
              type: c.op === "add" ? "tool_addition" : "tool_removal",
              tool: { type: "tool_reference", name: c.tool },
            })),
          });
        } else {
          out.push({ role: "system", content: m.content });
        }
        break;
      }
      case "user":
        out.push({
          role: "user",
          content: [
            { type: "text", text: m.content, ...(anchor ? { cache_control: cc } : {}) },
          ],
        });
        break;
      case "assistant": {
        const content: unknown[] = [];
        // Thinking blocks must come first and must be byte-identical to what
        // the provider sent. Reordering or editing them invalidates the
        // signature and the request is rejected.
        for (const r of m.reasoning ?? []) {
          if (r.kind === "opaque" && r.raw) content.push(r.raw);
        }
        if (m.content) content.push({ type: "text", text: m.content });
        for (const tc of m.toolCalls ?? []) {
          content.push({ type: "tool_use", id: tc.id, name: tc.name, input: tc.args });
        }
        if (content.length === 0) content.push({ type: "text", text: "" });
        if (anchor) {
          (content[content.length - 1] as Record<string, unknown>)["cache_control"] = cc;
        }
        out.push({ role: "assistant", content });
        break;
      }
      case "tool": {
        const content = m.results.map((r, j) => ({
          type: "tool_result",
          tool_use_id: r.callId,
          content: r.content,
          ...(r.isError ? { is_error: true } : {}),
          ...(anchor && j === m.results.length - 1 ? { cache_control: cc } : {}),
        }));
        out.push({ role: "user", content });
        break;
      }
    }
  }
  return out;
}
