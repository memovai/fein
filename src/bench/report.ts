import type { BenchTask } from "./tasks.js";
import { CONFIGS } from "./configs.js";

export interface Row {
  task: string;
  config: string;
  ok: boolean;
  failure?: string;
  cloudIn: number;
  cloudOut: number;
  localIn: number;
  localOut: number;
  usd: number;
  ms: number;
  cacheHitRate: number;
  prefixBreaks: number;
  calls: number;
  /** Calls a routing policy diverted off the default route. */
  escalations: number;
}

/**
 * Render the comparison.
 *
 * Two rules this report follows, both learned from the toolformer:
 *
 *  1. **Show the delta against the control, not just absolutes.** A table of
 *     raw numbers lets you tell yourself a story; a `+14%` next to a mechanism
 *     does not. The toolformer looked reasonable in absolute terms for months.
 *  2. **Never print a cost saving next to a wrong answer.** Cheapness is only
 *     interesting among configurations that got the task right, so failures are
 *     called out first and excluded from the "cheapest" verdict.
 */
export function report(rows: Row[], opts: { scripted: boolean; tasks: BenchTask[] }): string {
  const out: string[] = [];
  const control = "cloud-only";

  out.push("");
  out.push(opts.scripted ? "FE!N benchmark — scripted (mechanism overhead)" : "FE!N benchmark — live models");
  out.push("=".repeat(72));
  if (opts.scripted) {
    out.push(
      "Scripted models always find the answer, so correctness is NOT measured here.\n" +
        "What this measures exactly: what each mechanism costs to HAVE, and what it\n" +
        "saves when it actually engages.\n" +
        "\n" +
        "Read the two separately. A mechanism that does not engage on a task still\n" +
        "costs its tool schema and its system-prompt paragraph on every request —\n" +
        "that is the positive delta you see on tasks it cannot help with, and it is\n" +
        "real. The negative deltas are where it earned its place.\n" +
        "\n" +
        "CAVEAT: the scripted think model never spawns a subagent, so `cloud+subagent`\n" +
        "here is pure fixed overhead with none of the benefit. It is a floor, not a\n" +
        "verdict. Only the live run can price the isolation it buys.\n" +
        "\n" +
        "Run without --scripted (needs a key + Ollama) for the correctness question.",
    );
  }
  out.push("");

  for (const task of opts.tasks) {
    const taskRows = rows.filter((r) => r.task === task.id);
    if (taskRows.length === 0) continue;
    const base = taskRows.find((r) => r.config === control);

    out.push(`── ${task.id} ${"─".repeat(Math.max(0, 66 - task.id.length))}`);
    out.push(`   ${task.exercises}`);
    out.push("");
    out.push(
      pad("config", 20) +
        pad("cloud in/out", 16) +
        pad("local in/out", 15) +
        pad("usd", 11) +
        pad("Δ vs control", 14) +
        (opts.scripted ? "" : "  result"),
    );

    for (const r of taskRows) {
      const delta =
        base && base.usd > 0 && r.config !== control
          ? `${r.usd >= base.usd ? "+" : ""}${(((r.usd - base.usd) / base.usd) * 100).toFixed(0)}%`
          : r.config === control
            ? "—"
            : "n/a";
      // Did the mechanism actually do anything on this task?
      const engaged = r.localIn > 0 ? "" : r.config.includes("digest") || r.config.startsWith("hybrid") ? "  (idle)" : "";
      const escalated = r.escalations > 0 ? `  [${r.escalations} escalation(s)]` : "";
      const verdict = (opts.scripted ? engaged : r.ok ? "  ok" : "  WRONG") + escalated;
      out.push(
        pad(r.config, 20) +
          pad(`${tok(r.cloudIn)}/${tok(r.cloudOut)}`, 16) +
          pad(r.localIn ? `${tok(r.localIn)}/${tok(r.localOut)}` : "—", 15) +
          pad(`$${r.usd.toFixed(5)}`, 11) +
          pad(delta, 14) +
          verdict,
      );
      if (r.failure) out.push(`${" ".repeat(22)}${r.failure}`);
    }
    out.push("");
  }

  // ── summary across tasks ──────────────────────────────────────────────────
  out.push("── summary " + "─".repeat(62));
  out.push("");
  out.push(
    pad("config", 20) + pad("total usd", 12) + pad("total s", 10) + pad("cache hit", 12) +
      (opts.scripted ? pad("breaks", 8) : pad("correct", 10)),
  );

  for (const cfg of CONFIGS) {
    const rs = rows.filter((r) => r.config === cfg.id);
    if (rs.length === 0) continue;
    const usd = rs.reduce((n, r) => n + r.usd, 0);
    const ms = rs.reduce((n, r) => n + r.ms, 0);
    const hit = rs.reduce((n, r) => n + r.cacheHitRate, 0) / rs.length;
    const breaks = rs.reduce((n, r) => n + r.prefixBreaks, 0);
    const correct = rs.filter((r) => r.ok).length;
    out.push(
      pad(cfg.id, 20) +
        pad(`$${usd.toFixed(5)}`, 12) +
        pad((ms / 1000).toFixed(1), 10) +
        pad(`${(hit * 100).toFixed(1)}%`, 12) +
        (opts.scripted ? pad(String(breaks), 8) : pad(`${correct}/${rs.length}`, 10)),
    );
  }
  out.push("");

  // The verdict — only among configurations that were actually correct.
  if (!opts.scripted) {
    const byConfig = CONFIGS.map((c) => {
      const rs = rows.filter((r) => r.config === c.id);
      return { id: c.id, all: rs.every((r) => r.ok), usd: rs.reduce((n, r) => n + r.usd, 0), n: rs.length };
    }).filter((c) => c.n > 0);

    const correct = byConfig.filter((c) => c.all);
    if (correct.length === 0) {
      out.push("No configuration answered every task correctly. Cost comparison withheld —");
      out.push("a cheaper wrong answer is not cheaper.");
    } else {
      const best = correct.reduce((a, b) => (a.usd <= b.usd ? a : b));
      out.push(`Cheapest fully-correct configuration: ${best.id} at $${best.usd.toFixed(5)}.`);
      const wrong = byConfig.filter((c) => !c.all);
      if (wrong.length) {
        out.push(`Excluded for wrong answers: ${wrong.map((c) => c.id).join(", ")}.`);
      }
    }
    out.push("");
  }

  const anyBreaks = rows.reduce((n, r) => n + r.prefixBreaks, 0);
  if (anyBreaks > 0) {
    out.push(`WARNING: ${anyBreaks} prefix break(s) — the cache discipline regressed. See DESIGN.md §2.`);
    out.push("");
  }

  return out.join("\n");
}

function pad(s: string, n: number): string {
  return s.length >= n ? `${s.slice(0, n - 1)} ` : s + " ".repeat(n - s.length);
}

function tok(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}
