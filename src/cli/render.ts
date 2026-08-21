import { stdout } from "node:process";
import type { FeinTrace } from "../core/loop.js";

/**
 * The trace renderer is a product decision, not decoration. A hybrid harness
 * that hides which model did what is asking for blind trust in the one place
 * users have most reason to be skeptical. Every line says who served it and
 * whether they were local or cloud.
 */

export const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  magenta: (s: string) => `\x1b[35m${s}\x1b[0m`,
};

export const BANNER = `${c.bold("FE!N")} ${c.dim("— hybrid local-and-cloud agent harness")}`;

/**
 * The trace renderer is a product decision, not decoration. A hybrid harness
 * that hides which model did what is asking for blind trust in the one place
 * users have most reason to be skeptical. Every line says who served it and
 * whether they were local or cloud.
 */
export function renderTrace(e: FeinTrace): void {
  switch (e.type) {
    case "step":
      stdout.write(
        `\n${c.dim(`[${e.n}]`)} ${c.bold("think")} ${c.dim("·")} ${e.model} ` +
          `${e.locality === "local" ? c.green("local") : c.cyan("cloud")}\n`,
      );
      break;
    case "text":
      stdout.write(`${e.text}\n`);
      break;
    case "delegate":
      stdout.write(
        `  ${c.magenta("delegate")} ${e.tool} ${c.dim("←")} "${e.intent}"\n` +
          `           ${c.dim(`${e.outcome} · ${e.servedBy}`)}\n`,
      );
      break;
    case "verdict":
      stdout.write(
        `  ${e.allow ? c.green("verify allow") : c.red("verify deny ")} ` +
          `${c.dim(`${e.reason} · ${e.servedBy}`)}\n`,
      );
      break;
    case "tool_start":
      stdout.write(`  ${c.yellow("tool")} ${e.name}(${fmtArgs(e.args)}) ${c.dim(`via ${e.via}`)}\n`);
      break;
    case "tool_end":
      stdout.write(
        `       ${e.ok ? c.green("ok") : c.red("err")} ${c.dim(truncate(e.preview, 100))}\n`,
      );
      break;
    case "digest":
      stdout.write(
        `  ${c.green("digest")} ${e.tool}: ${e.from} → ${e.to} tok ` +
          `${c.dim(`(${Math.round((1 - e.to / e.from) * 100)}% smaller · ${e.servedBy})`)}\n`,
      );
      break;
    case "cache":
      stdout.write(
        e.stable
          ? c.dim(`  cache: prefix stable — ${e.reused} msg reused, ${e.added} new\n`)
          : c.red(`  cache: PREFIX BROKE at message ${e.brokenAt} — full reprocess\n`),
      );
      break;
    case "epoch":
      stdout.write(c.yellow(`  epoch: ${e.reason} — cache intentionally reset\n`));
      break;
    case "thought":
      stdout.write(`  ${c.dim("thought")} ${c.dim(truncate(e.text, 100))}\n`);
      break;
    case "steer_applied":
      stdout.write(
        `  ${c.magenta("steer")} ${e.count} message(s) applied at turn ${e.turn}\n`,
      );
      break;
    case "steer_deferred":
      stdout.write(
        c.yellow(`  ${e.count} steer(s) arrived after the last turn — they apply to your next message\n`),
      );
      break;
    case "steer":
      break; // the CLI echoes this itself, with queue depth
    case "route":
      stdout.write(
        `  ${c.yellow("route")} ${e.slot} -> ${e.model}` +
          `${e.thinking ? ` thinking=${e.thinking}` : ""} ${c.dim(truncate(e.reason, 70))}\n`,
      );
      break;
    case "guard":
      stdout.write(`  ${c.yellow(`guard/${e.kind}`)} ${c.dim(truncate(e.message, 90))}\n`);
      break;
    case "agent_start":
    case "agent_end":
    case "turn_start":
    case "turn_end":
      break; // structure, not narration — the step line already marks the turn
    case "spill":
      stdout.write(
        `  ${c.green("spill")} ${e.tool}: ${fmtBytes(e.fromBytes)} → ${fmtBytes(e.toBytes)} ` +
          `${c.dim(`(full text at ${e.path})`)}\n`,
      );
      break;
    case "hook_deny":
      stdout.write(`  ${c.red("hook deny")} ${e.tool} ${c.dim(e.reason)}\n`);
      break;
    case "subagent":
      stdout.write(`  ${c.magenta("subagent")} ${c.dim(`depth ${e.depth}`)} ${truncate(e.task, 90)}\n`);
      break;
    case "keepwarm":
      stdout.write(c.dim(`  keepwarm #${e.n}: ${e.cacheReadTokens} tok read from cache\n`));
      break;
    case "done":
      break;
  }
}

function fmtArgs(args: Record<string, unknown>): string {
  return Object.entries(args)
    .map(([k, v]) => `${k}: ${truncate(JSON.stringify(v) ?? "", 48)}`)
    .join(", ");
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}


/**
 * Local wall-clock, not UTC.
 *
 * Cron schedules are evaluated in local time (a user writing "0 3 * * *"
 * means 3am where they are), so printing the next run in UTC shows a
 * different-looking hour and reads as a bug. Display must match the semantics.
 */
export function localTime(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function fmtBytes(n: number): string {
  return n >= 1024 ? `${(n / 1024).toFixed(1)}KB` : `${n}B`;
}
