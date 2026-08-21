import type {
  Binding,
  CompletionRequest,
  CompletionResult,
  ModelPort,
  RouteHints,
  StepName,
  ThinkingLevel,
} from "../core/types.js";

export class SlotUnboundError extends Error {
  constructor(slot: StepName) {
    super(
      `no model bound to slot "${slot}". Bind one with .bind("${slot}", port), or the harness ` +
        `will not know who should do this part of the loop.`,
    );
    this.name = "SlotUnboundError";
  }
}

export interface RouteOutcome {
  result: CompletionResult;
  port: ModelPort;
  /** Ports that threw before this one succeeded. */
  attempts: Array<{ port: ModelPort; error: string }>;
  /** Present when a policy routed this call somewhere other than the default. */
  decision?: { reason: string; escalated: boolean; thinking?: ThinkingLevel; restart?: boolean };
  /** Ports demoted to the back of the chain by the failure cooldown. */
  cooledDown?: string[];
}

/** Consecutive failures before a port is demoted behind its alternates. */
const COOLDOWN_AFTER_FAILS = 2;
/** Demoted ports get probed again every Nth call, so recovery is noticed. */
const COOLDOWN_PROBE_EVERY = 8;

/**
 * The Router is the whole "model as a plugin" idea in one object: the loop
 * asks for a *slot* ("who serves observe?"), never for a model. Rebinding a
 * slot changes who does that job with no change to loop logic, which is what
 * lets the same harness run all-cloud, all-local, or any mixture.
 *
 * Fallback is per-slot rather than global on purpose. A dead local model
 * should degrade the observe slot to the cloud think model — a slower, pricier,
 * still-correct loop — not take the session down.
 */
export class Router {
  private bindings = new Map<StepName, Binding>();
  /**
   * Failure cooldown, counted in calls rather than wall-clock on purpose: a
   * clock would make routing depend on when the run happened, and the record
   * is supposed to replay. After COOLDOWN_AFTER_FAILS consecutive throws a
   * port is demoted to the back of its chain (still reachable — last resort,
   * not banished), and probed in front again every COOLDOWN_PROBE_EVERY
   * calls so a recovered runtime is noticed. Without this, every call to a
   * slot with a dead primary pays a doomed connection attempt first.
   */
  private failures = new Map<ModelPort, { consecutive: number; skips: number }>();

  bind(slot: StepName, port: ModelPort, opts: Omit<Binding, "slot" | "port"> = {}): this {
    this.bindings.set(slot, { slot, port, ...opts });
    return this;
  }

  /** Bind a slot only if nothing is bound yet — used for sensible defaults. */
  bindDefault(slot: StepName, port: ModelPort, opts: Omit<Binding, "slot" | "port"> = {}): this {
    if (!this.bindings.has(slot)) this.bind(slot, port, opts);
    return this;
  }

  has(slot: StepName): boolean {
    return this.bindings.has(slot);
  }

  binding(slot: StepName): Binding {
    const b = this.bindings.get(slot);
    if (!b) throw new SlotUnboundError(slot);
    return b;
  }

  /**
   * Resolve the port a request would go to. Callers that size work to the
   * target's context window (the observe step's chunk budget) must consult
   * this with the same hints they will later pass to `run`, so budget and
   * executor agree.
   */
  portFor(slot: StepName, hints?: RouteHints): ModelPort {
    const b = this.binding(slot);
    if (!b.policy) return b.port;
    return b.policy.decide(b, { system: "", messages: [] }, hints ?? {}).port;
  }

  async run(
    slot: StepName,
    req: CompletionRequest,
    signal?: AbortSignal,
    hints?: RouteHints,
  ): Promise<RouteOutcome> {
    const b = this.binding(slot);
    const alternates = [b.port, ...(b.fallbacks ?? [])];

    // A policy may reorder the chain and raise the thinking level; it may not
    // invent ports. Escalation-by-exception below stays exactly as it was.
    let chain = alternates;
    let decision: RouteOutcome["decision"];
    if (b.policy) {
      const d = b.policy.decide(b, req, hints ?? {});
      if (!alternates.includes(d.port)) {
        throw new Error(
          `policy for slot "${slot}" chose port "${d.port.info.id}", which is neither ` +
            `the primary nor a declared fallback`,
        );
      }
      chain = [d.port, ...alternates.filter((p) => p !== d.port)];
      const escalated = d.port !== b.port || (d.thinking !== undefined && req.thinking === undefined);
      if (escalated || d.restart) {
        decision = {
          reason: d.reason,
          escalated,
          thinking: d.thinking,
          ...(d.restart ? { restart: true } : {}),
        };
      }
      req = { ...req, thinking: req.thinking ?? d.thinking };
    }

    // Failure cooldown: demote known-bad ports behind their alternates, but
    // only when an alternate exists — a chain of one has nothing to prefer.
    let cooledDown: string[] | undefined;
    if (chain.length > 1) {
      const demoted: ModelPort[] = [];
      const kept = chain.filter((port) => {
        const f = this.failures.get(port);
        if (!f || f.consecutive < COOLDOWN_AFTER_FAILS) return true;
        if (f.skips >= COOLDOWN_PROBE_EVERY - 1) {
          f.skips = 0; // probe: try it in its normal position this call
          return true;
        }
        f.skips++;
        demoted.push(port);
        return false;
      });
      if (demoted.length > 0 && kept.length > 0) {
        chain = [...kept, ...demoted];
        cooledDown = demoted.map((p) => p.info.id);
      }
    }

    const attempts: RouteOutcome["attempts"] = [];

    for (const port of chain) {
      try {
        const result = await port.complete(
          {
            ...req,
            maxTokens: req.maxTokens ?? b.maxTokens,
            temperature: req.temperature ?? b.temperature,
          },
          signal,
        );
        this.failures.delete(port);
        return { result, port, attempts, decision, ...(cooledDown ? { cooledDown } : {}) };
      } catch (err) {
        const f = this.failures.get(port) ?? { consecutive: 0, skips: 0 };
        f.consecutive++;
        this.failures.set(port, f);
        attempts.push({ port, error: err instanceof Error ? err.message : String(err) });
      }
    }
    throw new Error(
      `slot "${slot}" failed on all ${chain.length} port(s): ` +
        attempts.map((a) => `${a.port.info.id}: ${a.error}`).join(" | "),
    );
  }

  describe(): string {
    const rows = [...this.bindings.values()].map((b) => {
      const fb = b.fallbacks?.length ? ` -> ${b.fallbacks.map((f) => f.info.id).join(" -> ")}` : "";
      const tag = b.port.info.locality === "local" ? "local" : "cloud";
      return `  ${b.slot.padEnd(11)} ${b.port.info.id} [${tag}]${fb}`;
    });
    return rows.join("\n");
  }
}
