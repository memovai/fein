import type { CompletionResult, ModelInfo, StepName } from "../core/types.js";

/**
 * The Ledger turns FE!N's two central claims into measured numbers rather
 * than architectural vibes:
 *
 *   1. "Delegating to local models saves money."  -> cost by locality, and
 *      counterfactual cloud cost for work the local model actually did.
 *   2. "We keep the cloud KV cache hot."          -> cache read/write ratio,
 *      realized savings, and every prefix break with the slot that caused it.
 *
 * A harness that cannot show these numbers is asking to be trusted. One that
 * can is asking to be checked, which is the only version worth shipping.
 */
export interface CallRecord {
  slot: StepName;
  model: ModelInfo;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  latencyMs: number;
  /** True if a prefix break was detected on this call. */
  prefixBroken: boolean;
  brokenAt?: number;
  /** True if a routing policy sent this call somewhere other than the default. */
  escalated?: boolean;
  /** The policy's stated rationale, recorded verbatim. */
  routeReason?: string;
}

export interface LedgerSummary {
  calls: number;
  byLocality: Record<"local" | "cloud", { calls: number; inTok: number; outTok: number; usd: number; ms: number }>;
  bySlot: Record<
    string,
    { calls: number; usd: number; ms: number; local: number; cloud: number; escalations: number }
  >;
  /** Calls a routing policy escalated (port swap or raised thinking). */
  escalations: number;
  cache: {
    readTokens: number;
    writeTokens: number;
    freshTokens: number;
    /** cacheRead / (cacheRead + fresh input). The headline number. */
    hitRate: number;
    /** USD saved vs. paying full price for every cached token. */
    savedUsd: number;
    breaks: Array<{ slot: StepName; model: string; at: number }>;
  };
  totalUsd: number;
  totalMs: number;
  /**
   * What the locally-served work would have cost at the think model's cloud rate.
   * This is an estimate, not a bill: token counts differ across tokenizers.
   */
  offloadedUsdEstimate: number;
}

/** Anthropic-style multipliers; the shape holds for OpenAI-family too. */
const CACHE_READ_MULTIPLIER = 0.1;
const CACHE_WRITE_MULTIPLIER = 1.25;

export class Ledger {
  private records: CallRecord[] = [];

  record(
    slot: StepName,
    model: ModelInfo,
    result: CompletionResult,
    prefix?: { stable: boolean; brokenAt?: number },
    route?: { escalated: boolean; reason: string },
  ): void {
    this.records.push({
      slot,
      model,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      cacheReadTokens: result.usage.cacheReadTokens,
      cacheWriteTokens: result.usage.cacheWriteTokens,
      latencyMs: result.latencyMs,
      prefixBroken: prefix ? !prefix.stable : false,
      ...(prefix?.brokenAt !== undefined ? { brokenAt: prefix.brokenAt } : {}),
      ...(route?.escalated ? { escalated: true, routeReason: route.reason } : {}),
    });
  }

  get all(): readonly CallRecord[] {
    return this.records;
  }

  /**
   * Fold a subagent's ledger into this one.
   *
   * A subagent's spend is the parent's spend. Keeping them separate would let
   * a delegating agent report a flattering per-turn cost while the real bill
   * accumulates in children nobody totals — which is exactly the accounting
   * failure that makes multi-agent systems surprising at the end of the month.
   */
  absorb(other: Ledger): void {
    this.records.push(...other.all);
  }

  private costOf(r: CallRecord): number {
    const inUsd = (r.inputTokens / 1e6) * r.model.costPerMTokIn;
    const readUsd = (r.cacheReadTokens / 1e6) * r.model.costPerMTokIn * CACHE_READ_MULTIPLIER;
    const writeUsd = (r.cacheWriteTokens / 1e6) * r.model.costPerMTokIn * CACHE_WRITE_MULTIPLIER;
    const outUsd = (r.outputTokens / 1e6) * r.model.costPerMTokOut;
    return inUsd + readUsd + writeUsd + outUsd;
  }

  summary(thinkRates?: { in: number; out: number }): LedgerSummary {
    const byLocality: LedgerSummary["byLocality"] = {
      local: { calls: 0, inTok: 0, outTok: 0, usd: 0, ms: 0 },
      cloud: { calls: 0, inTok: 0, outTok: 0, usd: 0, ms: 0 },
    };
    const bySlot: LedgerSummary["bySlot"] = {};
    let readTokens = 0;
    let writeTokens = 0;
    let freshTokens = 0;
    let totalUsd = 0;
    let totalMs = 0;
    let offloaded = 0;
    let escalations = 0;
    const breaks: LedgerSummary["cache"]["breaks"] = [];

    for (const r of this.records) {
      const usd = this.costOf(r);
      const loc = byLocality[r.model.locality];
      loc.calls++;
      loc.inTok += r.inputTokens + r.cacheReadTokens;
      loc.outTok += r.outputTokens;
      loc.usd += usd;
      loc.ms += r.latencyMs;

      const slot = (bySlot[r.slot] ??= { calls: 0, usd: 0, ms: 0, local: 0, cloud: 0, escalations: 0 });
      slot.calls++;
      slot.usd += usd;
      slot.ms += r.latencyMs;
      slot[r.model.locality]++;
      if (r.escalated) {
        slot.escalations++;
        escalations++;
      }

      readTokens += r.cacheReadTokens;
      writeTokens += r.cacheWriteTokens;
      freshTokens += r.inputTokens;
      totalUsd += usd;
      totalMs += r.latencyMs;

      if (r.model.locality === "local" && thinkRates) {
        offloaded +=
          ((r.inputTokens + r.cacheReadTokens) / 1e6) * thinkRates.in +
          (r.outputTokens / 1e6) * thinkRates.out;
      }
      if (r.prefixBroken) {
        breaks.push({ slot: r.slot, model: r.model.id, at: r.brokenAt ?? -1 });
      }
    }

    // Savings = what the cached tokens would have cost at full price, minus
    // what we actually paid to read (0.1x) and write (1.25x) them.
    let savedUsd = 0;
    for (const r of this.records) {
      const full = (r.cacheReadTokens / 1e6) * r.model.costPerMTokIn;
      const paidRead = full * CACHE_READ_MULTIPLIER;
      const paidWrite = (r.cacheWriteTokens / 1e6) * r.model.costPerMTokIn * CACHE_WRITE_MULTIPLIER;
      const wouldPayWrite = (r.cacheWriteTokens / 1e6) * r.model.costPerMTokIn;
      savedUsd += full - paidRead - (paidWrite - wouldPayWrite);
    }

    const denom = readTokens + freshTokens;
    return {
      calls: this.records.length,
      byLocality,
      bySlot,
      cache: {
        readTokens,
        writeTokens,
        freshTokens,
        hitRate: denom > 0 ? readTokens / denom : 0,
        savedUsd,
        breaks,
      },
      escalations,
      totalUsd,
      totalMs,
      offloadedUsdEstimate: offloaded,
    };
  }

  format(thinkRates?: { in: number; out: number }): string {
    const s = this.summary(thinkRates);
    const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
    const usd = (n: number) => `$${n.toFixed(4)}`;
    const lines: string[] = [];
    lines.push(`calls ${s.calls}  ·  ${usd(s.totalUsd)}  ·  ${(s.totalMs / 1000).toFixed(1)}s`);
    lines.push(
      `  local  ${String(s.byLocality.local.calls).padStart(3)} calls  ` +
        `${fmtTok(s.byLocality.local.inTok)} in / ${fmtTok(s.byLocality.local.outTok)} out  ` +
        `${usd(s.byLocality.local.usd)}`,
    );
    lines.push(
      `  cloud  ${String(s.byLocality.cloud.calls).padStart(3)} calls  ` +
        `${fmtTok(s.byLocality.cloud.inTok)} in / ${fmtTok(s.byLocality.cloud.outTok)} out  ` +
        `${usd(s.byLocality.cloud.usd)}`,
    );
    lines.push(
      `  cache  hit ${pct(s.cache.hitRate)}  ` +
        `read ${fmtTok(s.cache.readTokens)} / fresh ${fmtTok(s.cache.freshTokens)}  ` +
        `saved ${usd(s.cache.savedUsd)}`,
    );
    if (s.offloadedUsdEstimate > 0) {
      lines.push(`  offload  ~${usd(s.offloadedUsdEstimate)} of cloud spend served locally`);
    }
    if (s.cache.breaks.length > 0) {
      lines.push(`  ! ${s.cache.breaks.length} prefix break(s):`);
      for (const b of s.cache.breaks.slice(0, 5)) {
        lines.push(`      ${b.slot} on ${b.model} at message ${b.at}`);
      }
    }
    if (s.escalations > 0) {
      lines.push(`  ! ${s.escalations} escalation(s):`);
      for (const r of this.records.filter((r) => r.escalated).slice(0, 5)) {
        lines.push(`      ${r.slot} -> ${r.model.id} (${r.routeReason ?? ""})`);
      }
    }
    for (const [slot, v] of Object.entries(s.bySlot)) {
      lines.push(
        `  ${slot.padEnd(11)} ${String(v.calls).padStart(3)}x  ${usd(v.usd).padStart(9)}  ` +
          `${(v.ms / 1000).toFixed(1)}s  (${v.local} local / ${v.cloud} cloud)`,
      );
    }
    return lines.join("\n");
  }
}

function fmtTok(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}
