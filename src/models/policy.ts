import type {
  Binding,
  CompletionRequest,
  ModelPort,
  RouteHints,
  RoutePolicy,
  ThinkingLevel,
} from "../core/types.js";

/**
 * Routing policies: the adaptive layer DESIGN.md §7 left unwritten.
 *
 * Every policy here is a pure function of (binding, request, hints), and every
 * hint is derivable from the recorded transcript — guard fires are system
 * notes in the main channel, rejects are recorded skip reasons, request sizes
 * are recomputable from the rendered messages. Replaying a transcript
 * re-derives the same decisions, so adaptive routing does not make sessions
 * less reproducible than static binding. Two further honesty notes:
 *
 *  - Outcomes are in the record regardless: every assistant event names the
 *    port that produced it ("think@cloud"), and every policy decision is
 *    additionally logged as a `route` trace event and in the ledger.
 *  - Exception fallback (a port *throwing*) stays as nondeterministic as it
 *    always was. Policies add no new nondeterminism to that path.
 *
 * What is deliberately NOT here: cost/latency-aware routing (inherently
 * nondeterministic — the "two clocks" open problem stays open), and any policy
 * that swaps the think model's port mid-session. That last one is a
 * correctness hazard, not just a cost one: (a) provider prompt caches are
 * keyed per model, so a swap is a 100% cold start on a prefix that may be
 * 100k+ tokens; (b) opaque reasoning blocks are replayed verbatim
 * (`Reasoning.kind === "opaque"`), and one model's signed thinking blocks are
 * a provider *error* when replayed to another model. The industry converged
 * on the same rule: switch models only where the context is rebuilt anyway
 * (subagent spawn, compaction), and use an effort dial, not a model swap, as
 * the fine-grained escalation knob.
 */

const DEFAULT_LADDER: ThinkingLevel[] = ["medium", "high"];

/**
 * Escalate the think model's *effort*, never its port mid-epoch, when the
 * loop guard reports the model going in circles. First fire gets ladder[0],
 * second ladder[1], and so on, saturating at the top rung.
 *
 * Raising `thinking` keeps the port — and therefore the replayed prefix —
 * identical, so the system/tools prefix stays cached and PrefixGuard (which
 * checks message content, not request params) raises no false alarms.
 * Anthropic message-level breakpoints behind changed request params may still
 * re-write: cheap, not free.
 *
 * With `restartTo`, the ladder gains a top: once every rung is spent and the
 * guard fires again, the decision carries `restart: true` — a request that
 * the loop compact early and restart the epoch from a plain-text summary.
 * That boundary is the one place a think-model swap is free (the restart
 * pays the cache cost anyway, and the lens replays no opaque reasoning across
 * an epoch), so after the restart the policy routes to `restartTo` for the
 * whole new epoch. The switch condition reads only epoch-frozen hints
 * (`restartCount`, `stuckBeforeRestart`), so it provably cannot flip
 * mid-epoch. With the default two-rung ladder the restart needs a third
 * guard fire; bind a shorter ladder (e.g. `["high"]`) to reach it sooner.
 */
export function escalateOnStuck(opts?: {
  ladder?: ThinkingLevel[];
  restartTo?: ModelPort;
}): RoutePolicy {
  const ladder = opts?.ladder ?? DEFAULT_LADDER;
  if (ladder.length === 0) throw new Error("escalateOnStuck: ladder must not be empty");
  const restartTo = opts?.restartTo;
  const rungFor = (fires: number): ThinkingLevel =>
    ladder[Math.max(Math.min(fires - 1, ladder.length - 1), 0)]!;
  return {
    ...(restartTo ? { ports: [restartTo] } : {}),
    decide(binding: Binding, _req: CompletionRequest, hints: RouteHints) {
      // Post-restart: pinned to the stronger port for the whole epoch. The
      // condition is a ratchet over frozen values — it never un-switches.
      const restarted =
        restartTo !== undefined &&
        (hints.restartCount ?? 0) >= 1 &&
        (hints.stuckBeforeRestart ?? 0) > ladder.length;
      if (restarted) {
        return {
          port: restartTo,
          ...(hints.pressure === "stuck" ? { thinking: rungFor(hints.pressureCount ?? 1) } : {}),
          reason: `restarted on ${restartTo.info.id} after ${hints.stuckBeforeRestart} stuck fire(s)`,
        };
      }

      if (hints.pressure !== "stuck") return { port: binding.port, reason: "" };
      const fires = hints.pressureCount ?? 1;
      const thinking = rungFor(fires);
      const wantRestart = restartTo !== undefined && fires > ladder.length;
      return {
        port: binding.port,
        thinking,
        reason:
          `guard fired ${fires}x -> thinking=${thinking}` +
          (wantRestart ? `; ladder spent, requesting restart on ${restartTo!.info.id}` : ""),
        ...(wantRestart ? { restart: true } : {}),
      };
    },
  };
}

/**
 * Retry on a stronger port when the produced artifact failed a quality gate.
 * The FrugalGPT cascade with the gate as the scorer: try cheap, judge,
 * escalate once. Built for the observe slot, whose calls carry a fresh, small
 * context each time — so the swap has no cache stake at all.
 */
export function escalateOnReject(opts: { to: ModelPort }): RoutePolicy {
  return {
    ports: [opts.to],
    decide(binding: Binding, _req: CompletionRequest, hints: RouteHints) {
      if (hints.pressure !== "reject") return { port: binding.port, reason: "" };
      return { port: opts.to, reason: `quality gate rejected ${binding.port.info.id}'s output` };
    },
  };
}

/**
 * Send trivially small requests to a small model even when the slot's default
 * is big. For stateless side slots (observe, title) only — never bind this to
 * think: per-request port hopping on a growing context is exactly the
 * cache-hostile pattern the header comment forbids.
 */
export function rightSize(opts: { small: ModelPort; maxInputTokens?: number }): RoutePolicy {
  const threshold = opts.maxInputTokens ?? 1000;
  return {
    ports: [opts.small],
    decide(binding: Binding, _req: CompletionRequest, hints: RouteHints) {
      const size = hints.approxInputTokens;
      if (size === undefined || size > threshold) return { port: binding.port, reason: "" };
      return { port: opts.small, reason: `~${size} tokens <= ${threshold} -> ${opts.small.info.id}` };
    },
  };
}
