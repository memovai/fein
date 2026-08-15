import type { Binding, CompletionRequest, CompletionResult, ModelPort, StepName } from "../core/types.js";

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
}

/**
 * The Router is the whole "model as a plugin" idea in one object: the loop
 * asks for a *slot* ("who is the digester?"), never for a model. Rebinding a
 * slot changes who does that job with no change to loop logic, which is what
 * lets the same harness run all-cloud, all-local, or any mixture.
 *
 * Fallback is per-slot rather than global on purpose. A dead local model
 * should degrade the digester slot to the cloud driver — a slower, pricier,
 * still-correct loop — not take the session down.
 */
export class Router {
  private bindings = new Map<StepName, Binding>();

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

  portFor(slot: StepName): ModelPort {
    return this.binding(slot).port;
  }

  async run(slot: StepName, req: CompletionRequest, signal?: AbortSignal): Promise<RouteOutcome> {
    const b = this.binding(slot);
    const chain = [b.port, ...(b.fallbacks ?? [])];
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
        return { result, port, attempts };
      } catch (err) {
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
