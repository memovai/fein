import { join } from "node:path";
import { Transcript } from "./transcript.js";
import { MainLens, PrefixGuard } from "../context/lens.js";
import { Ledger } from "../telemetry/ledger.js";
import { Router } from "../models/router.js";
import { ToolRegistry } from "../tools/registry.js";
import { defaultTools } from "../tools/builtin.js";
import { digest, DEFAULT_DIGEST_POLICY, type DigestPolicy } from "../steps/observe.js";
import {
  spill,
  FileSpillStore,
  DEFAULT_SPILL_POLICY,
  type SpillPolicy,
  type SpillStore,
} from "../context/spill.js";
import { verify } from "../steps/verify.js";
import { thinkSections } from "../steps/prompts.js";
import { subagentTool, SpawnBudget, DEFAULT_SUBAGENT_OPTIONS, type SubagentOptions } from "../steps/subagent.js";
import { estimateTokens } from "../models/providers/scripted.js";
import { CacheKeeper } from "../cache/keeper.js";
import { HookRunner, type HookContext } from "../hooks/hooks.js";
import { LoopGuard, type GuardOptions } from "./guards.js";
import { SteeringQueue, formatSteers } from "./steering.js";
import { scanForVolatileContent, type SectionFingerprint } from "../steps/sections.js";
import type { SkillLibrary } from "../skills/skill.js";
import type { PersistentSession } from "../session/persist.js";
import type { ChatMessage, RouteHints, StepName, ToolCall, ToolResult, ToolSpec } from "./types.js";

export interface AgentOptions {
  router: Router;
  tools?: ToolRegistry;
  cwd?: string;
  systemExtra?: string;
  maxSteps?: number;
  allowSideEffects?: boolean;
  digestPolicy?: DigestPolicy;
  /** Model-free bounding of oversized tool output. Set `false` to disable. */
  spillPolicy?: SpillPolicy | false;
  /** Where spilled text lives. Defaults to `<cwd>/.fein/spill`. */
  spillDir?: string;
  /** Fraction of the think model's context window at which we compact. */
  compactAt?: number;
  /**
   * Keep the think model's prompt cache warm while the user is idle. Costs a real
   * (tiny) API call per refresh; see CacheKeeper for the trade-off. Off by
   * default because spending money on the user's behalf while they are not
   * looking should be opt-in.
   */
  keepCacheWarm?: boolean | { intervalMs?: number; maxRefreshes?: number };
  onEvent?: (e: FeinTrace) => void;

  /** Durable session. When present, every event is persisted as it happens. */
  session?: PersistentSession;
  /** Skill library; its index goes in the frozen system prompt (tier 2). */
  skills?: SkillLibrary;
  /** SOUL.md identity. Tier 1 — the most stable text in the prompt. */
  identity?: string;
  /** Project context files, already fenced. Tier 2 — stable, cacheable. */
  projectContext?: string;
  /** Lifecycle hooks, in-process and/or filesystem-driven. */
  hooks?: HookRunner;
  /** Subagent policy. Depth is enforced in code, not in the prompt. */
  subagents?: SubagentOptions | false;
  /** Nesting depth of this agent. 0 = top level. Set by the spawner. */
  depth?: number;
  /** Loop-hygiene thresholds: repeated calls, oscillation, stalling. */
  guards?: GuardOptions;
  /**
   * Which slot serves this agent's own turns. Defaults to "think".
   *
   * The zero-cache-cost model switch: a subagent starts from a fresh context,
   * so pointing a lightweight child at a cheaper binding (via
   * `subagents.thinkSlot`) routes the whole sub-task without breaking any
   * prefix. Small models drive tool-calling APIs badly and fail silently —
   * when the slot resolves to a small model, bind it with
   * `toolDialect: "react"` (see localOnlyProfile).
   */
  thinkSlot?: StepName;
  /**
   * Stop and report on the first loop-guard fire instead of nudging and
   * grinding on. Code-enforced fail-fast for cheap delegated executors: a
   * small model that has started repeating itself rarely recovers within its
   * step budget, and the caller — who can replan or escalate — should get the
   * blockage report while it is still cheap. Set automatically for light-tier
   * subagents; off for interactive parents, whose nudge often works.
   */
  bailOnStuck?: boolean;
  /**
   * Shared spawn allowance for the whole run.
   *
   * Created at the root when absent, and inherited by every child — it is a
   * shared object, so the tree spends one budget rather than one each.
   */
  spawnBudget?: SpawnBudget;
}

/** Human-facing trace of what the harness is doing and who is doing it. */
export type FeinTrace =
  | { type: "step"; n: number; slot: string; model: string; locality: "local" | "cloud" }
  | { type: "text"; text: string }
  | { type: "tool_start"; name: string; args: Record<string, unknown>; via: string }
  | { type: "tool_end"; name: string; ok: boolean; preview: string }
  | { type: "delegate"; tool: string; intent: string; outcome: string; servedBy: string }
  | { type: "digest"; tool: string; from: number; to: number; servedBy: string }
  | { type: "spill"; tool: string; fromBytes: number; toBytes: number; path: string }
  | { type: "verdict"; allow: boolean; reason: string; servedBy: string }
  | { type: "cache"; stable: boolean; reused: number; added: number; brokenAt?: number }
  | { type: "epoch"; reason: string }
  | { type: "keepwarm"; n: number; cacheReadTokens: number }
  | { type: "hook_deny"; tool: string; reason: string }
  | { type: "subagent"; depth: number; task: string }
  | { type: "agent_start"; task: string }
  | { type: "agent_end"; turns: number; stoppedBecause: string }
  | { type: "turn_start"; n: number; remaining: number; kind: TurnKind }
  | { type: "steer"; text: string; queued: number; running: boolean }
  | { type: "steer_applied"; count: number; turn: number }
  | { type: "steer_deferred"; count: number }
  | { type: "turn_end"; n: number; acted: boolean }
  | { type: "thought"; text: string }
  | { type: "guard"; kind: string; message: string }
  | { type: "route"; slot: string; model: string; reason: string; thinking?: string }
  | { type: "prompt_warning"; message: string }
  | { type: "done"; text: string };

/**
 * What caused this turn.
 *
 * Typed because the three are genuinely different: a `user` turn opens a task,
 * a `continue` turn is the loop carrying on by itself, and a `steer` turn is a
 * correction arriving mid-task. A trace that cannot tell them apart cannot
 * explain why the agent changed direction.
 */
export type TurnKind = "user" | "continue" | "steer";

/**
 * Options a child agent must not take from its parent, and why.
 *
 * This is the whole exclusion list. Anything not here is inherited, so adding a
 * new option is safe by default and only needs a decision when it genuinely
 * should not cross the boundary.
 */
const CHILD_NEVER_INHERITS = {
  /** A subagent is a separate conversation; it must not write to the parent's session. */
  session: undefined,
  /** No idle human is waiting on a child, so there is no cache to keep warm for one. */
  keepCacheWarm: undefined,
  /** The child's task comes from the spawn call, not from the parent's prompt extras. */
  systemExtra: undefined,
} satisfies Partial<AgentOptions>;

export interface RunResult {
  text: string;
  steps: number;
  stoppedBecause: "final_answer" | "max_steps" | "stuck";
}

/**
 * The FE!N agent loop.
 *
 * The loop itself is deliberately boring: render, ask the think model, execute
 * tools, ingest results, repeat. All of FE!N's opinions live in *who* answers
 * each of those questions and *how the record is maintained between them*:
 *
 *   render   -> MainLens, which guarantees prefix monotonicity
 *   ask      -> Router, which resolves the "think" slot to any model
 *   tools    -> the think model's own calls, gated by hooks and (for subagents)
 *               by the verify model
 *   ingest   -> the observe model, which compresses before first render
 *
 * Swap any of those bindings and the loop does not change. That is the whole
 * thesis: the model is a component of the loop, not the loop's owner.
 */
export class Agent {
  readonly ledger = new Ledger();
  readonly router: Router;
  readonly tools: ToolRegistry;
  readonly depth: number;

  /**
   * Both of these move when a compaction epoch forks the session, so they are
   * getters over mutable refs rather than readonly fields. Callers keep a
   * stable `agent.transcript` reference and always see the *current*
   * generation — which is what they want; the previous generation is reachable
   * through the store's lineage, not through a stale object handle.
   */
  private activeTranscript: Transcript;
  private sessionRef: PersistentSession | undefined;

  get transcript(): Transcript {
    return this.activeTranscript;
  }

  get session(): PersistentSession | undefined {
    return this.sessionRef;
  }

  private readonly hooks: HookRunner;
  private readonly lens: MainLens;
  private readonly guard = new PrefixGuard();
  private readonly loopGuard: LoopGuard;
  /** Guard fires this run. Feeds "stuck" pressure to the think routing policy. */
  private stuckCount = 0;
  /** Epoch restarts this run. Frozen between compactions; see RouteHints. */
  private restartCount = 0;
  /** stuckCount as of the most recent restart. Frozen with restartCount. */
  private stuckBeforeRestart = 0;
  /** A routing policy asked for an early epoch; honored at the next turn start. */
  private restartRequested = false;
  /** The slot serving this agent's own turns. "think" unless the spawner said otherwise. */
  private readonly thinkSlot: StepName;
  private readonly bailOnStuck: boolean;
  private readonly steering = new SteeringQueue();
  /** The options this agent was built from, so a child can inherit them. */
  private readonly opts: AgentOptions;
  private readonly spawnBudget: SpawnBudget;
  private running = false;
  private readonly cwd: string;
  private readonly maxSteps: number;
  private readonly allowSideEffects: boolean;
  private readonly digestPolicy: DigestPolicy;
  private readonly spillPolicy: SpillPolicy;
  private readonly spillStore: SpillStore | undefined;
  private readonly compactAt: number;
  private readonly onEvent: (e: FeinTrace) => void;
  private readonly systemPrompt: string;
  /** Per-section digests, so a cache break can be attributed to a section. */
  readonly promptSections: SectionFingerprint[];
  private readonly toolSpecs: ToolSpec[];
  private readonly keeper: CacheKeeper | undefined;
  private currentStep = 0;
  /**
   * The provider's own count of the last request's prompt size.
   *
   * `estimateTokens` is chars/4 — good enough to route, wrong enough to matter
   * at a compaction boundary, where being 30% low means blowing the context
   * window and being 30% high means paying for a summary you did not need.
   * But the provider tells us the true number on every response and we were
   * throwing it away. So: estimate only until the first real answer arrives,
   * then trust the provider and use the estimate solely for the *delta* since.
   */
  private lastRealPromptTokens = 0;
  /** The instruction this agent is working on — the verify model checks against it. */
  private task = "";

  constructor(opts: AgentOptions) {
    this.opts = opts;
    this.router = opts.router;
    this.tools = opts.tools ?? defaultTools();
    this.cwd = opts.cwd ?? process.cwd();
    this.maxSteps = opts.maxSteps ?? 24;
    this.allowSideEffects = opts.allowSideEffects ?? true;
    this.digestPolicy = opts.digestPolicy ?? DEFAULT_DIGEST_POLICY;
    this.spillPolicy = opts.spillPolicy === false ? { ...DEFAULT_SPILL_POLICY, maxInlineBytes: 0 }
      : (opts.spillPolicy ?? DEFAULT_SPILL_POLICY);
    this.spillStore =
      this.spillPolicy.maxInlineBytes > 0
        ? new FileSpillStore(opts.spillDir ?? join(opts.cwd ?? process.cwd(), ".fein/spill"))
        : undefined;
    this.compactAt = opts.compactAt ?? 0.75;
    this.onEvent = opts.onEvent ?? (() => {});
    this.hooks = opts.hooks ?? new HookRunner();
    this.loopGuard = new LoopGuard(opts.guards ?? {});
    this.thinkSlot = opts.thinkSlot ?? "think";
    this.bailOnStuck = opts.bailOnStuck ?? false;
    // The root creates the budget; children inherit the same object by spread,
    // which is exactly the sharing this needs.
    this.spawnBudget =
      opts.spawnBudget ??
      new SpawnBudget(opts.subagents === false
        ? 0
        : (opts.subagents?.maxTotalSpawns ?? DEFAULT_SUBAGENT_OPTIONS.maxTotalSpawns));
    this.depth = opts.depth ?? 0;

    // A persisted session owns its transcript, because resume replays into it.
    this.sessionRef = opts.session;
    this.activeTranscript = opts.session?.transcript ?? new Transcript();

    // Subagent tool is added *before* freezing, and is absent entirely at the
    // depth cap — an unavailable capability costs no tokens and cannot be
    // argued with, unlike a tool that always refuses.
    if (opts.subagents !== false) {
      const tool = subagentTool({
        budget: this.spawnBudget,
        router: this.router,
        ledger: this.ledger,
        tools: this.tools,
        cwd: this.cwd,
        depth: this.depth,
        allowSideEffects: this.allowSideEffects,
        ...(opts.subagents ? { options: opts.subagents } : {}),
        spawn: async (a) => {
          // Inherit by default; exclude on purpose. The previous shape listed
          // the fields to carry across, which meant every new option was
          // inherited only if someone remembered — and twice, nobody did
          // (`digestPolicy` and `skills`, then `spillPolicy`). Both failures
          // were silent, and both defeated the reason subagents exist.
          //
          // Spreading inverts the failure mode. Forget something now and the
          // child inherits it, which is almost always what you wanted; the
          // things that genuinely must not cross are named once, below, with
          // the reason attached.
          const child = new Agent({
            ...this.opts,
            ...CHILD_NEVER_INHERITS,
            // The one safe model-switch point: the child's context is fresh,
            // so re-pointing its turns at a cheaper binding breaks no prefix.
            // Precedence mirrors the industry pattern: the LLM's per-spawn
            // tier choice beats the static subagents.thinkSlot config, which
            // beats inheriting the parent's own slot.
            ...(opts.subagents && opts.subagents.thinkSlot
              ? { thinkSlot: opts.subagents.thinkSlot }
              : {}),
            ...(a.tier === "light"
              ? { thinkSlot: "execute" as const, bailOnStuck: true }
              : a.tier === "heavy"
                ? { thinkSlot: this.thinkSlot, bailOnStuck: false }
                : {}),
            // Shared *by reference*, not inherited by value. A child that
            // builds its own budget turns the run-level cap into a per-subtree
            // cap — which is precisely the explosion it exists to prevent
            // (measured: a per-agent limit of 3 at depth 3 produced 40 agents).
            spawnBudget: this.spawnBudget,
            router: a.router,
            tools: a.tools,
            cwd: a.cwd,
            depth: a.depth,
            maxSteps: a.maxSteps,
            allowSideEffects: a.allowSideEffects,
            hooks: this.hooks,
            onEvent: this.onEvent,
          });
          const r = await child.run(a.task);
          // Costs roll up: a subagent's spend is the parent's spend.
          this.ledger.absorb(child.ledger);
          return { text: r.text, steps: r.steps, stoppedBecause: r.stoppedBecause };
        },
      });
      if (tool) this.tools.register(tool);
    }

    // System prompt and tool block are computed once and frozen. Both sit at
    // the very front of every request; recomputing them per turn is the
    // easiest way to destroy a prompt cache, so we make it structurally
    // impossible rather than merely discouraged. Note what is *absent*: no
    // timestamp, no step counter, no memory snapshot. Those go in appended
    // system-role messages instead (see injectContext).
    const sections = thinkSections({
      workspace: this.cwd,
      hybrid: this.router.has("observe"),
      memory: opts.session !== undefined,
      subagents: opts.subagents !== false && this.tools.get("spawn_subagent") !== undefined,
      tiers:
        opts.subagents !== false &&
        this.tools.get("spawn_subagent") !== undefined &&
        this.router.has("execute"),
      ...(opts.skills ? { skillIndex: opts.skills.index() } : {}),
      ...(opts.identity ? { identity: opts.identity } : {}),
      ...(opts.projectContext ? { projectContext: opts.projectContext } : {}),
      ...(opts.systemExtra !== undefined ? { extra: opts.systemExtra } : {}),
    });

    // Catch per-turn content before a single request is sent, rather than
    // discovering it as a permanent cache miss later.
    for (const section of sections.list()) {
      const problem = scanForVolatileContent(section);
      if (problem) this.onEvent({ type: "prompt_warning", message: problem });
    }
    this.promptSections = sections.fingerprint();
    this.systemPrompt = sections.build();
    this.toolSpecs = this.tools.specs();
    this.tools.freeze();

    // The observe model's lens substitution only makes sense if an observe model exists.
    this.lens = new MainLens(this.router.has("observe"));

    const warm = opts.keepCacheWarm;
    this.keeper = warm
      ? new CacheKeeper({
          port: this.router.portFor(this.thinkSlot),
          ledger: this.ledger,
          ...(typeof warm === "object" ? warm : {}),
          onRefresh: (n, cacheReadTokens) =>
            this.onEvent({ type: "keepwarm", n, cacheReadTokens }),
        })
      : undefined;
  }

  private hookCtx(step: number): HookContext {
    return {
      ...(this.sessionRef ? { sessionId: this.sessionRef.id } : {}),
      cwd: this.cwd,
      step,
    };
  }

  /**
   * Run one task to completion.
   *
   * The loop is organised around **turns**, not raw steps. A turn is one
   * complete Thought → Action → Observation cycle: the model reasons, acts, and
   * sees the result. That is the unit the model experiences, the unit a guard
   * can judge for progress, and the unit worth reporting — a "step" counter
   * that ticks somewhere inside a turn tells nobody anything.
   */
  async run(userInput: string, signal?: AbortSignal): Promise<RunResult> {
    // Two concurrent runs would interleave writes to the transcript, making
    // message order depend on scheduling — which breaks prefix monotonicity and
    // therefore the cache, intermittently and undebuggably. Steering exists
    // precisely so that a second message has somewhere safe to go, so point at
    // it rather than just refusing.
    if (this.running) {
      throw new Error(
        "this agent is already running. A second concurrent run() would race the transcript " +
          "and corrupt message order. To send a message to the run in flight, use " +
          "agent.steer(text) — it is delivered at the next turn boundary.",
      );
    }
    this.running = true;

    // Real traffic refreshes the cache for free; stop paying for heartbeats.
    this.keeper?.touch();
    await this.hooks.sessionStart(this.hookCtx(0));
    this.task = userInput;
    this.transcript.user(userInput);
    this.onEvent({ type: "agent_start", task: userInput });

    for (let turn = 1; turn <= this.maxSteps; turn++) {
      this.currentStep = turn;

      // The one safe moment: a completed cycle, before the next render. An
      // append here extends the prefix; anywhere else would rewrite it.
      const steers = this.steering.drain();
      const kind: TurnKind = steers.length ? "steer" : turn === 1 ? "user" : "continue";
      if (steers.length) {
        this.transcript.user(formatSteers(steers));
        this.onEvent({ type: "steer_applied", count: steers.length, turn });
      }

      this.onEvent({ type: "turn_start", n: turn, remaining: this.maxSteps - turn, kind });

      await this.maybeCompact();

      const think = await this.think(turn, signal);
      if (think.done) {
        this.onEvent({ type: "turn_end", n: turn, acted: false });
        return await this.finish(think.text, turn, "final_answer", think.messages);
      }

      const results = await this.executeBatch(think.calls, signal);
      this.onEvent({ type: "turn_end", n: turn, acted: true });

      // Judge the completed cycle, not the half of it the model can see.
      const signalOut = this.loopGuard.observe({
        calls: think.calls,
        results,
        hadAnswer: false,
      });
      if (signalOut) {
        this.onEvent({ type: "guard", kind: signalOut.kind, message: signalOut.message });
        if (this.bailOnStuck) {
          // Fail fast: report the blockage instead of grinding. The caller
          // (a planner holding the step's acceptance criteria) decides what
          // happens next — retry heavier, replan, or do it itself.
          return await this.forceFinalAnswer(signal, {
            note:
              "You appear to be repeating yourself without making progress, and you should " +
              "stop here. Report what you established, what you tried, and what is blocking " +
              "you. Do not claim the task is complete.",
            why: "stuck",
          });
        }
        // Delivered as an appended system-role note: free against the cache,
        // and it cannot be forged by anything that lands in tool output.
        this.transcript.systemNote(signalOut.message);
        // Also reported to the think binding's routing policy (if one is
        // bound) as "stuck" pressure. Sticky for the rest of the run: the
        // count only rises, so escalation never flaps. Derivable from the
        // system notes above, which keeps replays honest.
        this.stuckCount++;
      }
    }

    // Out of turns. Returning whatever the model happened to say last is the
    // worst option: it is usually a fragment of reasoning about a step that
    // never completed. Ask for a real answer instead.
    return await this.forceFinalAnswer(signal);
  }

  /** Pressure facts for the think binding's routing policy, if one is bound. */
  private thinkHints(): RouteHints {
    return {
      ...(this.stuckCount > 0
        ? { pressure: "stuck" as const, pressureCount: this.stuckCount }
        : {}),
      ...(this.restartCount > 0
        ? { restartCount: this.restartCount, stuckBeforeRestart: this.stuckBeforeRestart }
        : {}),
    };
  }

  /** One model turn: render, ask, record. */
  private async think(
    turn: number,
    signal?: AbortSignal,
  ): Promise<
    | { done: true; text: string; messages: ChatMessage[] }
    | { done: false; calls: ToolCall[]; messages: ChatMessage[] }
  > {
    const messages = this.lens.render(this.transcript);
    const prefix = this.guard.check(messages);
    this.onEvent({
      type: "cache",
      stable: prefix.stable,
      reused: prefix.reusedMessages,
      added: prefix.newMessages,
      ...(prefix.brokenAt !== undefined ? { brokenAt: prefix.brokenAt } : {}),
    });

    await this.hooks.beforeModel(this.hookCtx(turn), this.thinkSlot, messages);

    const { result, port, decision } = await this.router.run(
      this.thinkSlot,
      {
        system: this.systemPrompt,
        messages,
        tools: this.toolSpecs,
        cacheAnchors: ["system", "tools", "lastMessage"],
        ...(this.cacheScope() ? { cacheScope: this.cacheScope()! } : {}),
      },
      signal,
      this.thinkHints(),
    );
    this.ledger.record(this.thinkSlot, port.info, result, prefix, decision);
    if (decision?.restart) this.restartRequested = true;
    if (decision?.escalated) {
      this.onEvent({
        type: "route",
        slot: this.thinkSlot,
        model: port.info.id,
        reason: decision.reason,
        ...(decision.thinking ? { thinking: decision.thinking } : {}),
      });
    }
    // Cached reads still occupied the window, so the true prompt size is
    // fresh + cached, not just what we were billed at full rate.
    this.lastRealPromptTokens = result.usage.inputTokens + result.usage.cacheReadTokens;
    await this.hooks.afterModel(this.hookCtx(turn), this.thinkSlot, result.text);
    this.onEvent({
      type: "step",
      n: turn,
      slot: this.thinkSlot,
      model: port.info.id,
      locality: port.info.locality,
    });

    this.transcript.assistant(
      result.text,
      result.toolCalls,
      `${this.thinkSlot}@${port.info.id}`,
      "main",
      result.reasoning,
    );
    if (result.reasoning?.length) {
      const thought = result.reasoning.map((r) => r.text).filter(Boolean).join(" ");
      if (thought) this.onEvent({ type: "thought", text: thought });
    }
    if (result.text.trim()) this.onEvent({ type: "text", text: result.text });

    return result.toolCalls.length === 0
      ? { done: true, text: result.text, messages }
      : { done: false, calls: result.toolCalls, messages };
  }

  /**
   * Ask for an answer with no tools available.
   *
   * Withholding the tools is what makes this terminate: the model *cannot*
   * start another cycle, so it has to answer with what it has. Telling it not
   * to would be a request; removing the capability is a guarantee — the same
   * reasoning as the subagent depth cap.
   */
  private async forceFinalAnswer(
    signal?: AbortSignal,
    opts?: { note: string; why: RunResult["stoppedBecause"] },
  ): Promise<RunResult> {
    // A steer typed during the final turn would otherwise sit in the queue
    // until some later run — the user's last words silently not applied to the
    // answer they were aimed at. Deliver them before asking for the wrap-up.
    const late = this.steering.drain();
    if (late.length) {
      this.transcript.user(formatSteers(late));
      this.onEvent({ type: "steer_applied", count: late.length, turn: this.maxSteps });
    }

    this.transcript.systemNote(
      opts?.note ??
        `You have used all ${this.maxSteps} available turns and cannot take further actions. ` +
          `Answer now with what you have established. State what you found, and say plainly ` +
          `what is still unresolved rather than implying the task is complete.`,
    );

    const messages = this.lens.render(this.transcript);
    try {
      const { result, port, decision } = await this.router.run(
        this.thinkSlot,
        { system: this.systemPrompt, messages, cacheAnchors: ["system", "lastMessage"] },
        signal,
        this.thinkHints(),
      );
        this.ledger.record(this.thinkSlot, port.info, result, undefined, decision);
      this.transcript.assistant(
        result.text,
        [],
        `${this.thinkSlot}@${port.info.id}`,
        "main",
        result.reasoning,
      );
      if (result.text.trim()) this.onEvent({ type: "text", text: result.text });
      return await this.finish(result.text, this.maxSteps, opts?.why ?? "max_steps", messages);
    } catch {
      // The wrap-up call is a courtesy, not a requirement. If it fails, fall
      // back to the old behaviour rather than losing the whole run.
      const last = this.lastAssistantText();
      this.running = false;
      return { text: last, steps: this.maxSteps, stoppedBecause: opts?.why ?? "max_steps" };
    }
  }

  /**
   * A conversation identity that survives compaction.
   *
   * Returns the lineage root rather than the current session id, so a fork does
   * not look like a new conversation to a provider routing on cache affinity.
   */
  private cacheScope(): string | undefined {
    if (!this.sessionRef) return undefined;
    try {
      return this.sessionRef.store.lineageRoot(this.sessionRef.id);
    } catch {
      return undefined;
    }
  }

  /** Shared exit path: arm the cache keeper, fire hooks, report. */
  private async finish(
    text: string,
    turns: number,
    why: RunResult["stoppedBecause"],
    messages: ChatMessage[],
  ): Promise<RunResult> {
    this.onEvent({ type: "done", text });
    // The turn is over and the user is about to think. Arm the keeper on the
    // exact prefix the next turn will extend.
    this.keeper?.arm({ system: this.systemPrompt, messages, tools: this.toolSpecs }, this.toolSpecs);
    this.keeper?.start();
    await this.hooks.sessionEnd(this.hookCtx(turns), { steps: turns, text });
    this.running = false;
    // Anything queued after the last drain stays for the next run rather than
    // being dropped — but silence would read as "applied", so say it.
    if (this.steering.depth > 0) {
      this.onEvent({ type: "steer_deferred", count: this.steering.depth });
    }
    this.onEvent({ type: "agent_end", turns, stoppedBecause: why });
    return { text, steps: turns, stoppedBecause: why };
  }

  /**
   * Execute a batch of tool calls from one think model turn.
   *
   * Two rules, both of which exist because of hybrid execution rather than in
   * spite of it:
   *
   * **Results are appended in call order, never completion order.** When the
   * think model issues three calls and we run them concurrently, they finish in
   * whatever order the filesystem and the local model feel like. Appending in
   * completion order makes the transcript — and therefore the prompt prefix —
   * depend on machine timing. The same session replayed twice would produce
   * different prefixes, and every provider cache lookup would miss for
   * reasons no one could reproduce. Concurrency is a latency optimization; it
   * must not be observable in the record.
   *
   * **Read-only calls run concurrently; side-effecting calls run one at a
   * time, in order.** Two parallel `write_file` calls to the same path have an
   * undefined winner. The concurrency win is overwhelmingly in the read path
   * anyway (that is where digestion latency lives), so serializing
   * mutations costs almost nothing and removes a whole class of race.
   */
  private async executeBatch(calls: ToolCall[], signal?: AbortSignal): Promise<ToolResult[]> {
    const resolved = new Array<{ result: ToolResult; toolName: string }>(calls.length);

    const parallel: Array<Promise<void>> = [];
    for (let i = 0; i < calls.length; i++) {
      const call = calls[i]!;
      if (this.mutates(call)) {
        // Drain in-flight reads first so a mutation never races a read of the
        // same path, then run this one alone.
        await Promise.all(parallel.splice(0));
        resolved[i] = await this.handleCall(call, signal);
      } else {
        parallel.push(this.handleCall(call, signal).then((r) => void (resolved[i] = r)));
      }
    }
    await Promise.all(parallel);

    // Bound and compress concurrently — but append strictly in call order.
    //
    // Both run against the FULL text, never against each other's output: a
    // digest of a truncated preview would summarize the truncation, and a
    // preview of a digest would slice a summary. They are two independent
    // views of the same original, and the lens picks between them.
    const [spills, digests] = await Promise.all([
      Promise.all(resolved.map((r) => this.maybeSpill(r.result, r.toolName))),
      Promise.all(
        resolved.map((r) =>
          digest({
            router: this.router,
            ledger: this.ledger,
            transcript: this.transcript,
            result: r.result,
            toolName: r.toolName,
            policy: this.digestPolicy,
            ...(signal !== undefined ? { signal } : {}),
          }),
        ),
      ),
    ]);

    for (let i = 0; i < resolved.length; i++) {
      const { result, toolName } = resolved[i]!;
      const event = this.transcript.toolResult(result);

      const sp = spills[i]!;
      if (sp.spilled && sp.content && sp.path) {
        this.transcript.spill(event.id, sp.content, sp.path, sp.originalBytes);
        this.onEvent({
          type: "spill",
          tool: toolName,
          fromBytes: sp.originalBytes,
          toBytes: sp.replacementBytes ?? 0,
          path: sp.path,
        });
      }

      const outcome = digests[i]!;
      if (outcome.digested && outcome.text) {
        this.transcript.digest(event.id, outcome.text, outcome.servedBy ?? "unknown");
        this.onEvent({
          type: "digest",
          tool: toolName,
          from: outcome.originalTokens,
          to: outcome.digestTokens ?? 0,
          servedBy: outcome.servedBy ?? "unknown",
        });
        if (outcome.escalated) {
          this.onEvent({
            type: "route",
            slot: "observe",
            model: outcome.servedBy ?? "unknown",
            reason: "quality gate rejected the default port's digest",
          });
        }
      }
    }

    return resolved.map((r) => r.result);
  }

  /**
   * Bound a result without a model. Free, lossless, and the floor under the
   * observe: even with no observe model bound, no single tool result can flood the
   * context window, and the full text stays one `grep` away.
   */
  private async maybeSpill(result: ToolResult, toolName: string) {
    if (!this.spillStore) {
      return { spilled: false as const, originalBytes: Buffer.byteLength(result.content, "utf8") };
    }
    return await spill({
      result,
      toolName,
      store: this.spillStore,
      policy: this.spillPolicy,
    });
  }

  /** Would this call mutate the world? */
  private mutates(call: ToolCall): boolean {
    return this.tools.get(call.name)?.spec.sideEffects === true;
  }

  /**
   * Resolve one call into a concrete tool result.
   *
   * The trust tier that survives: a call made by the *think model* executes as-is,
   * because the think model is acting on the user's instruction and is the
   * authority. A call made inside a **subagent** is acting on a task string
   * that another model wrote — nobody human ever approved those exact words —
   * so if it mutates the world it goes past the verify model first.
   *
   * That asymmetry is the same one that motivated the verify model originally, and
   * it is the only one left now that argument-materialization is gone. Hooks
   * cover rule-shaped policy; the verify model is the model-shaped check for when
   * the instruction itself came from a model.
   */
  private async handleCall(
    call: ToolCall,
    signal?: AbortSignal,
  ): Promise<{ result: ToolResult; toolName: string }> {
    const spec = this.tools.get(call.name)?.spec;

    if (this.depth > 0 && spec?.sideEffects && this.router.has("verify")) {
      const verdict = await verify({
        router: this.router,
        ledger: this.ledger,
        transcript: this.transcript,
        call,
        spec,
        intent: this.task,
        signal,
      });
      this.onEvent({
        type: "verdict",
        allow: verdict.allow,
        reason: verdict.reason,
        servedBy: verdict.servedBy,
      });
      if (!verdict.allow) {
        return {
          result: {
            callId: call.id,
            content:
              `Blocked by the verify model: ${verdict.reason}\n` +
              `This is a subagent, so mutations are checked against the task you were given.`,
            isError: true,
          },
          toolName: call.name,
        };
      }
    }

    return { result: await this.execute(call, this.thinkSlot, signal), toolName: call.name };
  }

  private async execute(call: ToolCall, via: string, signal?: AbortSignal): Promise<ToolResult> {
    this.onEvent({ type: "tool_start", name: call.name, args: call.args, via });
    void signal;

    // The gate. A hook may veto; a denial becomes an ordinary error result so
    // the model can adapt rather than the loop crashing.
    const decision = await this.hooks.beforeTool(this.hookCtx(this.currentStep), call);
    if (!decision.allow) {
      const denied: ToolResult = {
        callId: call.id,
        content: `Blocked by policy: ${decision.reason ?? "denied by hook"}`,
        isError: true,
      };
      this.onEvent({ type: "hook_deny", tool: call.name, reason: decision.reason ?? "denied" });
      this.onEvent({ type: "tool_end", name: call.name, ok: false, preview: denied.content });
      return denied;
    }

    const result = await this.tools.execute(call, {
      cwd: this.cwd,
      allowSideEffects: this.allowSideEffects,
    });
    await this.hooks.afterTool(this.hookCtx(this.currentStep), call, result);
    this.onEvent({
      type: "tool_end",
      name: call.name,
      ok: !result.isError,
      preview: result.content.slice(0, 160).replace(/\s+/g, " "),
    });
    return result;
  }

  /**
   * Compaction is the one operation that legitimately breaks the cache, so it
   * is explicit, priced, and rare — an "epoch".
   *
   * The usual sliding-window approach (drop the oldest messages each turn)
   * is quietly catastrophic for cached prompts: dropping message 3 shifts
   * every token after it, so the provider's cache misses on *every* turn once
   * the window starts sliding. You pay full input price forever, in exchange
   * for context you were going to lose anyway.
   *
   * An epoch instead pays the full cost once: summarize everything, restart
   * the rendered history from that summary, and then run cache-hot again for
   * many turns. Rare and expensive beats constant and cheap-looking.
   */
  private async maybeCompact(): Promise<void> {
    // Post-restart the routing policy may resolve a different port, so the
    // window that gates compaction must be the port that will actually serve.
    const port = this.router.portFor(this.thinkSlot, this.thinkHints());
    // A throwaway lens. `MainLens` freezes every event it renders, because
    // "already shown to the model" is what makes late digest substitution
    // unsafe (Rule 2). But this render is only a size estimate — it never
    // reaches a provider — so using the real lens here would freeze events
    // the think model has not seen yet, and the digest would silently never apply.
    const messages = new MainLens(this.router.has("observe")).render(this.transcript);
    const approx = this.approxPromptTokens(messages);
    // A policy-requested restart compacts early: the swap it wants is only
    // free at this boundary, and waiting for the size threshold would leave a
    // stuck model grinding on a hot cache nobody wants to preserve.
    const forced = this.restartRequested;
    if (!forced && approx < port.info.contextWindow * this.compactAt) return;

    await this.hooks.beforeCompact(this.hookCtx(this.currentStep), approx);

    const summarySlot = this.router.has("observe") ? "observe" : this.thinkSlot;
    // The summary is written by the *pre-restart* binding on purpose: the old
    // port reads the context it already has cached at the cached-read rate; a
    // new port would pay full price to read history it is about to discard.
    const { result, port: sPort } = await this.router.run(
      summarySlot,
      {
        system:
          "Summarize this agent session so work can continue without the full transcript. " +
          "Preserve: the user's goal, decisions made and why, files and commands touched with " +
          "exact names, findings, and what remains to be done. Be specific. No preamble.",
        messages,
        maxTokens: 1500,
        temperature: 0,
      },
      undefined,
      summarySlot === this.thinkSlot ? this.thinkHints() : undefined,
    );
    this.ledger.record(summarySlot, sPort.info, result);

    const reason = forced
      ? "routing policy requested a restart"
      : `context reached ${Math.round(this.compactAt * 100)}% of window`;

    // The epoch boundary freezes the restart facts the routing policy reads.
    // From here to the next epoch they are constants, which is what makes a
    // policy port switch stable for the whole epoch.
    this.restartRequested = false;
    this.restartCount++;
    this.stuckBeforeRestart = this.stuckCount;

    // With persistence, an epoch is a *fork*, not a truncation: the parent
    // session keeps every event, the child starts from the summary, and the
    // link between them is recorded. That is what turns "compacted" from
    // "lost" into "relocated" — the detail is still on disk, still searchable
    // via session_search, and still reachable via session_lineage.
    if (this.sessionRef) {
      const child = this.sessionRef.forkForEpoch(result.text, reason);
      this.sessionRef = child;
      this.activeTranscript = child.transcript;
      this.onEvent({
        type: "epoch",
        reason: `${reason} — compacted at ~${approx} tokens → forked to ${child.id}`,
      });
      return;
    }

    this.transcript.epoch(reason, result.text);
    this.onEvent({ type: "epoch", reason: `${reason} — compacted at ~${approx} tokens` });
  }

  /**
   * Best available estimate of the next request's prompt size.
   *
   * Before the first response we have only the character heuristic. After it,
   * we anchor on the provider's real count and add an estimate of what has been
   * appended since — a small delta on a large exact number, rather than a large
   * estimate of everything.
   */
  private approxPromptTokens(messages: ChatMessage[]): number {
    const heuristic = estimateTokens(this.systemPrompt + JSON.stringify(messages));
    if (this.lastRealPromptTokens === 0) return heuristic;
    return Math.max(this.lastRealPromptTokens, heuristic);
  }

  private lastAssistantText(): string {
    const events = this.transcript.channel("main");
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i]!;
      if (e.kind === "assistant" && e.text.trim()) return e.text;
    }
    return "";
  }

  /**
   * Send the agent a message while it is working.
   *
   * Lands at the next turn boundary — never mid-turn, because injecting between
   * an Action and its Observation would hand the model a user message where a
   * tool result belongs. Safe to call from another task; safe to call when the
   * agent is idle, in which case it simply arrives at the start of the next run.
   */
  steer(text: string): number {
    const depth = this.steering.push(text);
    this.onEvent({ type: "steer", text, queued: depth, running: this.running });
    return depth;
  }

  /** True while a run is in flight. Steers land at a boundary; they never race. */
  get isRunning(): boolean {
    return this.running;
  }

  /**
   * Make a deferred tool visible to the think model, without touching the cache.
   *
   * The tool must already have been declared with `deferLoading: true` before
   * the first turn — that is the whole trick. The tool block sits at the very
   * front of the prompt, so a genuinely new tool would shift every token after
   * it. A deferred tool is already in that block from turn one; surfacing it
   * appends a system-role message carrying a `tool_addition`, which extends
   * the prefix instead of rewriting it.
   */
  surfaceTool(name: string): void {
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`cannot surface unknown tool "${name}"`);
    if (!tool.spec.deferLoading) {
      throw new Error(
        `tool "${name}" is not deferred — it is already visible to the think model. ` +
          `Only tools declared with deferLoading: true need surfacing.`,
      );
    }
    this.transcript.toolChange("add", name);
  }

  /** Withdraw a tool mid-session. Also an append, also cache-safe. */
  revokeTool(name: string): void {
    if (!this.tools.get(name)) throw new Error(`cannot revoke unknown tool "${name}"`);
    this.transcript.toolChange("remove", name);
  }

  /**
   * Inject operator context mid-session — a mode change, a fact the app just
   * learned, an updated constraint.
   *
   * This exists because the obvious alternative is a trap: editing the system
   * prompt puts the new text at the front of the prefix, which invalidates the
   * cached conversation entirely. Appending a system-role message costs
   * nothing cached and, unlike smuggling the text into a user turn, cannot be
   * forged by anything that writes to user-visible input.
   */
  injectContext(text: string): void {
    this.transcript.systemNote(text);
  }

  /** Rendered view of what the think model currently sees. For inspection/debug. */
  view(): ChatMessage[] {
    return new MainLens(this.router.has("observe")).render(this.transcript);
  }
}
