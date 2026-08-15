import { createHash } from "node:crypto";
import type { ChatMessage, FeinEvent } from "../core/types.js";
import type { Transcript } from "../core/transcript.js";

/**
 * A Lens renders the canonical transcript into the message list one specific
 * binding will see. Lenses are where FE!N's KV-cache guarantee lives:
 *
 *   RENDER MONOTONICITY: for a given lens, every render must be a strict
 *   extension of the previous render. Nothing already sent to the model is
 *   ever edited, reordered, or removed (until an explicit epoch).
 *
 * Cloud providers key their prompt/KV cache on an exact prefix match of the
 * request. Monotonic renders mean turn N+1's prompt starts with turn N's
 * prompt, so the provider re-reads N's tokens from cache and only pays for
 * the delta. The same property gives llama.cpp / vLLM prefix-cache hits for
 * local models — the discipline is provider-agnostic.
 *
 * The subtle case is digestion: a local model may summarize a bulky tool
 * result so the cloud driver reads 200 tokens instead of 20k. That is only
 * cache-safe if the digest is substituted BEFORE the raw result is ever
 * rendered for that binding. This lens tracks which events it has already
 * rendered ("frozen") and refuses to substitute after the fact: a late digest
 * simply appends nothing, and the raw stays. Brevity never wins over prefix
 * stability.
 */
export class MainLens {
  /** Event ids this lens has already rendered — frozen against substitution. */
  private frozen = new Set<string>();
  /** Whether this binding prefers digests over raw tool output. */
  constructor(private readonly preferDigests: boolean) {}

  render(transcript: Transcript): ChatMessage[] {
    const events = transcript.channel("main");

    // Start from the latest epoch, if any (epoch = priced cache flush).
    let start = 0;
    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i]!.kind === "epoch") {
        start = i;
        break;
      }
    }

    // Index digests and spills by target event id.
    const digests = new Map<string, FeinEvent & { kind: "digest" }>();
    const spills = new Map<string, FeinEvent & { kind: "spill" }>();
    for (const e of events) {
      if (e.kind === "digest") digests.set(e.ofEventId, e);
      else if (e.kind === "spill") spills.set(e.ofEventId, e);
    }

    // A result whose call is nowhere in the log cannot be rendered — providers
    // reject a tool_result with no matching tool_use. Unlike an *unanswered*
    // call, this one cannot be repaired by appending, because there is nothing
    // to pair it with. So it is dropped from the view and kept in the log.
    const knownCallIds = new Set<string>();
    for (const e of events) {
      if (e.kind === "assistant") for (const c of e.toolCalls) knownCallIds.add(c.id);
    }

    const messages: ChatMessage[] = [];
    for (let i = start; i < events.length; i++) {
      const e = events[i]!;
      switch (e.kind) {
        case "epoch":
          messages.push({
            role: "user",
            content: `[context resumed from checkpoint]\n${e.snapshot}`,
          });
          break;
        case "user":
          messages.push({ role: "user", content: e.text });
          break;
        case "assistant":
          // Reasoning is replayed, not dropped. Providers that sign thinking
          // blocks require them back byte-identical, and a ReAct model that
          // cannot see its own prior Thoughts rediscovers them every turn.
          messages.push({
            role: "assistant",
            content: e.text,
            toolCalls: e.toolCalls,
            ...(e.reasoning?.length ? { reasoning: e.reasoning } : {}),
          });
          break;
        case "tool_result": {
          if (!knownCallIds.has(e.result.callId)) {
            this.frozen.add(e.id);
            break;
          }
          const digest = digests.get(e.id);
          const spilled = spills.get(e.id);
          const fresh = !this.frozen.has(e.id);

          // Preference order: a semantic digest beats a literal preview, and
          // either beats raw bulk. Both carry the spill locator when there is
          // one, because the whole point of pairing them is that the model can
          // go back for whatever the summary or the slice left out.
          let content = e.result.content;
          if (fresh && this.preferDigests && digest) {
            content =
              `[digest by ${digest.by}]\n${digest.text}` +
              (spilled ? `\n\n[Full output: ${spilled.path}]` : "\n[raw kept in transcript]");
          } else if (fresh && spilled) {
            content = spilled.preview;
          }

          messages.push({ role: "tool", results: [{ ...e.result, content }] });
          break;
        }
        case "system_note":
          messages.push({ role: "system", content: e.text });
          break;
        case "tool_change":
          messages.push({
            role: "system",
            content: "",
            toolChanges: [{ op: e.op, tool: e.tool }],
          });
          break;
        case "digest":
        case "note":
          break; // digests render via substitution; notes are harness-internal
      }
      this.frozen.add(e.id);
    }
    return messages;
  }
}

/** Structural hash of one rendered message, for prefix comparison. */
export function messageHash(m: ChatMessage): string {
  return createHash("sha256").update(JSON.stringify(m)).digest("hex").slice(0, 16);
}

export interface PrefixReport {
  stable: boolean;
  /** Index of the first message that differs from the previous render. */
  brokenAt?: number;
  reusedMessages: number;
  newMessages: number;
}

/**
 * PrefixGuard is the runtime tripwire for render monotonicity. Every render
 * destined for a provider passes through here; if a render fails to extend
 * the previous one, we know we just voluntarily invalidated the provider's
 * cache — a bug in harness logic, not a provider mystery. The guard makes
 * cache regressions loud and attributable instead of silently expensive.
 */
export class PrefixGuard {
  private prev: string[] = [];

  check(messages: ChatMessage[]): PrefixReport {
    const hashes = messages.map(messageHash);
    let brokenAt: number | undefined;
    for (let i = 0; i < this.prev.length; i++) {
      if (i >= hashes.length || hashes[i] !== this.prev[i]) {
        brokenAt = i;
        break;
      }
    }
    const report: PrefixReport =
      brokenAt === undefined
        ? {
            stable: true,
            reusedMessages: this.prev.length,
            newMessages: hashes.length - this.prev.length,
          }
        : { stable: false, brokenAt, reusedMessages: brokenAt, newMessages: hashes.length - brokenAt };
    this.prev = hashes;
    return report;
  }
}
