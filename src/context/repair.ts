import type { FeinEvent, ToolCall } from "../core/types.js";
import type { Transcript } from "../core/transcript.js";

/**
 * Transcript repair.
 *
 * A persisted session can be interrupted anywhere — Ctrl-C, a crash, a laptop
 * lid, a killed container. If it stops *between* an assistant's tool call and
 * the tool's result, the log is left with a `tool_use` that has no matching
 * `tool_result`, and that conversation is **invalid**: every provider rejects
 * a request whose assistant turn has an unanswered tool call. So the session
 * is not merely degraded on resume, it is unresumable — every subsequent
 * request 400s, forever, with an error that points at the request rather than
 * at the crash three days ago that caused it.
 *
 * This is the failure mode that makes durable sessions a liability instead of
 * a feature, and it does not exist until you add persistence. An in-memory
 * harness cannot hit it: the process that lost the tool result also lost the
 * transcript.
 *
 * The fix is to make resume total. Two defects, two different treatments:
 *
 *  - **An unanswered call is backfilled** with a synthetic error result, as a
 *    real appended event. Appending rather than hiding is the honest option:
 *    the log then *says* the call never completed, the model is told the same
 *    thing in words it can act on, and an auditor reading the session later
 *    sees the interruption instead of a suspiciously tidy history.
 *
 *  - **An orphan result** — a result whose call is nowhere in the log — cannot
 *    be repaired by appending, because there is nothing to pair it with. It is
 *    dropped at render time (see MainLens) and left in the log.
 *
 * Backfilling happens once, at resume, *before the first render*. That timing
 * is not incidental: it is the same constraint digestion obeys (Rule 2). Do it
 * later and you are rewriting a prefix the model has already seen.
 */

export interface RepairReport {
  /** Calls that never received a result, now backfilled. */
  backfilled: ToolCall[];
  /** Result ids with no matching call. Dropped at render, retained in the log. */
  orphaned: string[];
}

export const INTERRUPTED_RESULT =
  "This tool call never completed — the session was interrupted before a result was " +
  "recorded. Treat its outcome as unknown: if you still need it, call the tool again " +
  "rather than assuming it succeeded or failed.";

/**
 * Find tool calls in a channel that have no corresponding result.
 *
 * Order matters: a call is unpaired only if no result *anywhere later* in the
 * log answers it. Scanning the whole channel rather than the last turn handles
 * the case where an interrupted turn was followed by more activity — which
 * happens when a subagent's parent kept working after a child died.
 */
export function findUnpairedCalls(events: readonly FeinEvent[]): ToolCall[] {
  const answered = new Set<string>();
  const calls = new Map<string, ToolCall>();

  for (const e of events) {
    if (e.kind === "assistant") {
      for (const c of e.toolCalls) calls.set(c.id, c);
    } else if (e.kind === "tool_result") {
      answered.add(e.result.callId);
    }
  }
  return [...calls.entries()].filter(([id]) => !answered.has(id)).map(([, c]) => c);
}

/** Result ids that answer a call which does not exist. */
export function findOrphanResults(events: readonly FeinEvent[]): string[] {
  const known = new Set<string>();
  for (const e of events) {
    if (e.kind === "assistant") for (const c of e.toolCalls) known.add(c.id);
  }
  const orphans: string[] = [];
  for (const e of events) {
    if (e.kind === "tool_result" && !known.has(e.result.callId)) orphans.push(e.result.callId);
  }
  return orphans;
}

/**
 * Make a transcript safe to send to a provider.
 *
 * Idempotent: running it twice backfills nothing the second time, because the
 * synthetic results it appended are themselves results. That property is what
 * lets it run unconditionally on every resume without accumulating noise.
 */
export function repairTranscript(transcript: Transcript, channel = "main"): RepairReport {
  const events = transcript.channel(channel);
  const unpaired = findUnpairedCalls(events);
  const orphaned = findOrphanResults(events);

  for (const call of unpaired) {
    transcript.toolResult(
      { callId: call.id, content: INTERRUPTED_RESULT, isError: true },
      channel,
    );
  }

  return { backfilled: unpaired, orphaned };
}
