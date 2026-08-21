/**
 * FE!N core intermediate representation (IR).
 *
 * Everything a model says or sees is normalized into this IR. Providers
 * translate IR <-> wire format (Anthropic Messages, OpenAI Chat Completions,
 * llama.cpp / Ollama, ...). The IR is deliberately message-shaped rather than
 * token-shaped: hybrid routing means we can never assume two models share a
 * tokenizer, so alignment between models happens at the event level, never at
 * the token level.
 */

/** A tool invocation, normalized across provider formats. */
export interface ToolCall {
  /** Unique id, stable across the transcript (used to pair results). */
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface ToolResult {
  callId: string;
  /** Raw output of the tool. May be large; the observe model may summarize it. */
  content: string;
  isError: boolean;
}

/** JSON-Schema-ish tool declaration (subset that all providers understand). */
export interface ToolSpec {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, { type: string; description?: string; enum?: string[] }>;
    required?: string[];
  };
  /**
   * Tools that mutate the world require verification when proposed by a
   * low-trust binding (e.g. a small local model). See DESIGN.md "trust tiers".
   */
  sideEffects?: boolean;
  /**
   * Declared up front but not loaded into the model's context until surfaced
   * mid-conversation. This is what makes dynamic tool sets cache-safe: the
   * tool block — which sits at the very front of the prefix — is fixed from
   * turn one, and surfacing a deferred tool later appends a block rather than
   * rewriting the front. See Agent.surfaceTool.
   */
  deferLoading?: boolean;
}

/** A mid-conversation change to the available tool set. */
export interface ToolChange {
  op: "add" | "remove";
  tool: string;
}

/** Provider-agnostic chat message. */
export type ChatMessage =
  | { role: "system"; content: string; toolChanges?: ToolChange[] }
  | { role: "user"; content: string }
  | {
      role: "assistant";
      content: string;
      toolCalls?: ToolCall[];
      /** Thought. Replayed verbatim when `kind` is "opaque". */
      reasoning?: Reasoning[];
    }
  | { role: "tool"; results: ToolResult[] };

/** What the harness asks a model to do, in IR. */
export interface CompletionRequest {
  system: string;
  messages: ChatMessage[];
  tools?: ToolSpec[];
  maxTokens?: number;
  temperature?: number;
  stop?: string[];
  /**
   * A stable identifier for "this conversation", used by providers that route
   * on a cache key.
   *
   * It must survive compaction. When an epoch forks a session, the new session
   * has a new id but is the *same* conversation as far as caching is concerned,
   * and keying on the current session id would throw away affinity at exactly
   * the moment the prefix was rebuilt and is most expensive to re-establish. So
   * this is derived from the lineage **root**, which does not rotate.
   */
  cacheScope?: string;
  /**
   * How hard to think. `off` disables reasoning entirely; the rest are hints a
   * provider maps onto its own control (Anthropic effort, a ReAct prompt's
   * instruction to reason before acting).
   */
  thinking?: ThinkingLevel;
  /**
   * Indices into the rendered prompt where a persistent cache breakpoint is
   * worth paying for (Anthropic cache_control). Providers that do implicit
   * prefix caching (OpenAI, vLLM, llama.cpp) ignore this.
   */
  cacheAnchors?: CacheAnchor[];
}

export type CacheAnchor = "system" | "tools" | "lastMessage";

export type ThinkingLevel = "off" | "low" | "medium" | "high" | "max";

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  /** Tokens served from the provider's prompt/KV cache (0 if unknown). */
  cacheReadTokens: number;
  /** Tokens written to cache this call (Anthropic-style; 0 if unknown). */
  cacheWriteTokens: number;
}

export interface CompletionResult {
  text: string;
  toolCalls: ToolCall[];
  /** Thought, when the model produced any. */
  reasoning?: Reasoning[];
  usage: Usage;
  /** Wall-clock latency of the provider call, ms. */
  latencyMs: number;
  raw?: unknown;
}

/**
 * How a model expresses the *Action* half of the loop.
 *
 * These are three points on one axis — how much structure the provider gives
 * us, and therefore how much the harness has to reconstruct:
 *
 *  - `native`: the provider has a tool-calling API. Structure arrives typed.
 *  - `json`: the model emits a JSON object in prose and we parse it. Small
 *    models are markedly better at this than at driving a tool-calling API.
 *  - `react`: the model emits a `Thought:` / `Action:` transcript and we parse
 *    that. The most forgiving dialect, and the only one many small local models
 *    can sustain across a multi-step task — which makes it the dialect that
 *    decides whether a local model can *drive* at all, rather than only assist.
 *  - `none`: the model cannot act; bind it only to slots that never need to.
 */
export type ToolDialect = "native" | "json" | "react" | "none";

/**
 * The *Thought* half of the loop, carried explicitly.
 *
 * FE!N previously had only `text` on an assistant turn, which conflated two
 * different things: what the model reasoned, and what it said to the user. They
 * have different audiences, different lifetimes, and — critically — different
 * replay rules. Anthropic requires thinking blocks be echoed back byte-identical
 * on the next request; user-facing text has no such constraint. Storing them in
 * one field makes that rule impossible to honour.
 *
 * `opaque` carries provider-signed reasoning that must be replayed verbatim and
 * must not be edited, summarized, or reordered. `text` is reasoning we can read
 * — either a provider summary, or what a `react` model wrote after `Thought:`.
 */
export interface Reasoning {
  kind: "text" | "opaque";
  /** Human/model-readable reasoning. Empty when the provider omits it. */
  text: string;
  /** Provider-specific payload to replay unchanged (signatures, redacted blobs). */
  raw?: unknown;
}

export interface ModelInfo {
  id: string;
  provider: string;
  model: string;
  locality: "local" | "cloud";
  toolDialect: ToolDialect;
  /** Rough $/Mtok for routing decisions; 0 for local models. */
  costPerMTokIn: number;
  costPerMTokOut: number;
  contextWindow: number;
}

/**
 * ModelPort: the plugin surface. A model is just "something that completes".
 * The harness never imports a provider directly; it talks to ports resolved
 * by the router. This is what makes the model a meta-loop component: any
 * stage of the loop can be re-bound to a different port without touching the
 * loop itself.
 */
export interface ModelPort {
  readonly info: ModelInfo;
  complete(req: CompletionRequest, signal?: AbortSignal): Promise<CompletionResult>;
}

// ---------------------------------------------------------------------------
// Transcript events — the canonical, append-only source of truth.
// ---------------------------------------------------------------------------

/**
 * Channels partition the transcript. "main" is the conversation the think model
 * (usually the cloud model) sees. Side channels hold delegated local-model
 * work (tool-forming, digesting, verification) whose full contents must NEVER
 * enter the main channel retroactively — only appended summaries may — because
 * rewriting or interleaving history is exactly what destroys KV-cache hits.
 */
export type ChannelId = string; // "main" | "side:<n>"

export type FeinEvent =
  | { kind: "user"; id: string; ts: number; channel: ChannelId; text: string }
  | {
      kind: "assistant";
      id: string;
      ts: number;
      channel: ChannelId;
      text: string;
      toolCalls: ToolCall[];
      /** Thought, preserved so it can be replayed to the same model. */
      reasoning?: Reasoning[];
      /** Which binding produced this (e.g. "think@cloud"). */
      by: string;
    }
  | { kind: "tool_result"; id: string; ts: number; channel: ChannelId; result: ToolResult }
  | {
      /**
       * A digest replaces a bulky raw observation *in the rendered view* of
       * bindings configured to prefer digests — but only if the digest is
       * appended before the raw event is ever rendered into that binding's
       * prompt. Once rendered, raw stays (prefix stability beats brevity).
       */
      kind: "digest";
      id: string;
      ts: number;
      channel: ChannelId;
      ofEventId: string;
      text: string;
      by: string;
    }
  | {
      /**
       * Epoch: an explicit, priced cache flush. Compaction, tool-registry
       * changes, or system-prompt edits happen only here. Everything before
       * the epoch is re-rendered from the epoch's snapshot.
       */
      kind: "epoch";
      id: string;
      ts: number;
      channel: ChannelId;
      reason: string;
      snapshot: string;
    }
  | {
      /**
       * A bulky tool result was persisted to a file and bounded in the view.
       * Unlike a digest this is model-free and lossless: the preview is a
       * literal slice, and `path` is a retrieval route back to everything the
       * slice cut out.
       */
      kind: "spill";
      id: string;
      ts: number;
      channel: ChannelId;
      ofEventId: string;
      preview: string;
      path: string;
      originalBytes: number;
    }
  | {
      kind: "note";
      id: string;
      ts: number;
      channel: ChannelId;
      text: string;
      by: string;
    }
  | {
      /**
       * Operator context injected mid-session. Renders as a `system`-role
       * message *appended* to the conversation rather than as an edit to the
       * top-level system prompt — which would rewrite the front of the prefix
       * and cost the entire cache. Also the non-spoofable channel: text
       * smuggled into a user turn can be forged by anything that writes to
       * user-visible input; a system-role message cannot.
       */
      kind: "system_note";
      id: string;
      ts: number;
      channel: ChannelId;
      text: string;
    }
  | {
      /**
       * A deferred tool surfaced or revoked mid-session. Appends rather than
       * rewrites, so the tool block at the front of the prefix stays intact.
       */
      kind: "tool_change";
      id: string;
      ts: number;
      channel: ChannelId;
      op: "add" | "remove";
      tool: string;
    };

/**
 * The slots. Four serve stages of one turn; `execute` serves a delegated
 * sub-task's whole loop — the light tier of plan-execute delegation. It is
 * unbound by default: an unbound slot costs nothing and advertises nothing
 * (the spawn tool only offers a `tier` choice when `execute` is bound).
 */
export type StepName = "think" | "observe" | "verify" | "title" | "execute";

/** A model binding: a port plus slot-specific parameters. */
export interface Binding {
  slot: StepName;
  port: ModelPort;
  maxTokens?: number;
  temperature?: number;
  /** Fallback ports tried in order if this port throws. */
  fallbacks?: ModelPort[];
  /** Optional adaptive routing. Absent = the static binding, exactly as before. */
  policy?: RoutePolicy;
}

/**
 * Why a caller is asking for something other than the default route.
 * "stuck" — the loop guard saw the think model repeating itself.
 * "reject" — a produced artifact failed a quality gate (e.g. a bloated digest).
 */
export type RoutePressure = "stuck" | "reject";

/**
 * Facts a caller hands the policy. Hints are observations, never decisions:
 * the loop reports what happened; the policy decides what to do about it.
 * Every field must be derivable from the recorded transcript, which is what
 * keeps adaptive routing replayable (see RoutePolicy).
 */
export interface RouteHints {
  pressure?: RoutePressure;
  /** How many times the pressure has been observed (guard fires, rejects). */
  pressureCount?: number;
  /** Estimated input size, for right-sizing trivially small requests. */
  approxInputTokens?: number;
  /**
   * Epoch restarts (compactions) this run. Frozen between restarts, which is
   * what lets a policy switch ports at an epoch boundary and provably never
   * mid-epoch: a decision that depends only on this and `stuckBeforeRestart`
   * is constant for the whole epoch.
   */
  restartCount?: number;
  /** Total guard fires recorded up to the most recent restart. Frozen with it. */
  stuckBeforeRestart?: number;
}

/** What a policy decided, recorded verbatim in the trace and ledger. */
export interface RouteDecision {
  /** Must be the binding's primary or one of its declared fallbacks. */
  port: ModelPort;
  /** Per-call thinking override; used only when the request left it unset. */
  thinking?: ThinkingLevel;
  /** Human-readable rationale; empty string means the default route. */
  reason: string;
  /**
   * The policy wants an epoch restart at the next turn boundary — the one
   * moment a think-model swap is free (the summary restart pays the cache
   * cost anyway, and no opaque reasoning survives it). A request, not an
   * action: the loop honors it by compacting early; the policy itself never
   * mutates anything.
   */
  restart?: boolean;
}

/**
 * Adaptive routing, opt-in per binding.
 *
 * `decide` MUST be a pure function of its arguments. Every input is derivable
 * from the recorded transcript (guard notes, message sizes), so replaying the
 * same transcript re-derives the same decisions — which is how adaptive
 * routing coexists with the "concurrency must not be observable in the
 * record" rule. Latency- or error-rate-based policies are deliberately not
 * expressible here.
 */
export interface RoutePolicy {
  decide(binding: Binding, req: CompletionRequest, hints: RouteHints): RouteDecision;
}
