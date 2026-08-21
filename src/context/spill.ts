import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { ToolResult } from "../core/types.js";

/**
 * Spill: bound an oversized tool result **without a model**.
 *
 * FE!N's observe model reaches for an inference every time a tool returns something
 * bulky. That is the right tool for turning 3000 lines of log into "one test
 * failed, here, for this reason" — but it is the wrong tool for the much
 * simpler job of *not putting 3000 lines in the context window*, because it
 * costs a round trip, sits on the critical path, and is lossy in a way nobody
 * can undo.
 *
 * Spill does that simpler job for free and losslessly: write the full text to a
 * session-scoped file, and hand the model a bounded head/tail preview plus a
 * locator it can `read` or `grep`. Nothing is destroyed; the model can go get
 * whatever the preview cut out.
 *
 * ## Why both, and in this order
 *
 * They are complementary, and the failing-test fixture shows exactly why. A
 * 332-line test log with the one failure on line 241: head/tail preview
 * **misses it entirely**, while the observe model finds it. Conversely the digest is
 * a paraphrase — if it drops the line number, that detail is gone.
 *
 * So: spill always, digest additionally when an observe model is bound.
 *
 *   no observe model  →  bounded preview + locator      (was: unbounded raw text)
 *   observe model     →  semantic digest + locator      (was: digest, detail gone)
 *
 * The second row is the one that matters most: spill fixes the observe model's worst
 * property. A digest that drops something now has a retrieval path back to the
 * truth, which turns "lossy" into "summarized, with the source one tool call
 * away".
 *
 * ## Invariants
 *
 * 1. **The replacement never exceeds the cap.** The notice's byte cost is
 *    reserved out of the budget first, so the preview shrinks to fit rather
 *    than the total overflowing.
 * 2. **The replacement is never larger than the original.** If honouring (1)
 *    would produce something bigger than what it replaces, we keep the
 *    original — spilling must never *add* bytes.
 * 3. **Idempotent.** A spilled result is under the cap, so a second pass does
 *    nothing. No accumulating notices.
 * 4. **Best effort.** A write failure returns the original result unchanged. A
 *    full disk must never turn a successful tool call into an error.
 */

export interface SpillPolicy {
  /** Model-facing cap in UTF-8 bytes. 0 disables spilling entirely. */
  maxInlineBytes: number;
  /**
   * Tools exempt from spilling.
   *
   * `read` is the load-bearing entry: spilling a read's output would send the
   * model to `read` the spill file, whose output would spill again. The loop is
   * not hypothetical — it is the natural consequence of a retrieval hint that
   * names the same tool that triggered it.
   */
  never: string[];
  /** Fraction of the preview budget given to the head. The tail gets the rest. */
  headRatio: number;
}

export const DEFAULT_SPILL_POLICY: SpillPolicy = {
  maxInlineBytes: 8_000,
  never: ["read_file"],
  headRatio: 0.7,
};

export interface SpillOutcome {
  spilled: boolean;
  /** The bounded replacement, when spilled. */
  content?: string;
  /** Absolute path to the full text. */
  path?: string;
  originalBytes: number;
  replacementBytes?: number;
  skipReason?: string;
}

export interface SpillStore {
  /** Persist full text, return a locator the model can retrieve with. */
  save(toolName: string, text: string): Promise<string>;
}

/** Session-scoped files on disk. */
export class FileSpillStore implements SpillStore {
  private ensured = false;

  constructor(private readonly dir: string) {}

  async save(toolName: string, text: string): Promise<string> {
    if (!this.ensured) {
      await mkdir(this.dir, { recursive: true });
      this.ensured = true;
    }
    const safe = toolName.replace(/[^a-zA-Z0-9_-]/g, "_");
    const path = join(this.dir, `${Date.now()}-${randomUUID().slice(0, 8)}-${safe}.txt`);
    await writeFile(path, text, "utf8");
    return path;
  }
}

export async function spill(args: {
  result: ToolResult;
  toolName: string;
  store: SpillStore;
  policy?: SpillPolicy;
}): Promise<SpillOutcome> {
  const policy = args.policy ?? DEFAULT_SPILL_POLICY;
  const text = args.result.content;
  const originalBytes = Buffer.byteLength(text, "utf8");

  if (policy.maxInlineBytes <= 0) {
    return { spilled: false, originalBytes, skipReason: "spilling disabled" };
  }
  if (policy.never.includes(args.toolName)) {
    return { spilled: false, originalBytes, skipReason: `${args.toolName} is exempt` };
  }
  if (originalBytes <= policy.maxInlineBytes) {
    return { spilled: false, originalBytes, skipReason: "within cap" };
  }
  // An error's exact bytes are what you need precisely when things went wrong,
  // and errors are rarely the bulky ones. Same rule the observe model follows.
  if (args.result.isError) {
    return { spilled: false, originalBytes, skipReason: "error output kept verbatim" };
  }

  let path: string;
  try {
    path = await args.store.save(args.toolName, text);
  } catch (err) {
    return {
      spilled: false,
      originalBytes,
      skipReason: `spill store failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const notice = (omitted: number) =>
    `\n\n[Omitted ${omitted.toLocaleString()} bytes. Full output saved to ${path} — ` +
    `use grep to search it, or read it with an offset.]`;

  // The notice is a fixed cost that has to come out of the budget before the
  // preview gets any. Its own length depends on the omitted count, which
  // depends on the preview length — circular, but only weakly: the count only
  // ever shrinks the preview, and its digit count is stable. So: size it once
  // against the worst case, build, then verify.
  const noticeBytes = Buffer.byteLength(notice(originalBytes), "utf8");

  // When the notice alone does not fit, there is no replacement that both
  // honours the cap and carries a usable locator. Keeping the original is the
  // honest outcome — a "bounded" result that silently exceeds its bound is
  // worse than an unbounded one, because everything downstream trusts the bound.
  if (noticeBytes >= policy.maxInlineBytes) {
    return {
      spilled: false,
      originalBytes,
      skipReason:
        `cap of ${policy.maxInlineBytes} bytes is too small for the retrieval notice ` +
        `(${noticeBytes} bytes); raise maxInlineBytes or shorten the spill path`,
    };
  }

  const preview = headTail(text, policy.maxInlineBytes - noticeBytes, policy.headRatio);
  const replacement = preview + notice(originalBytes - Buffer.byteLength(preview, "utf8"));
  const replacementBytes = Buffer.byteLength(replacement, "utf8");

  // Belt and braces. The two sizings above should make this unreachable, but a
  // cap violation is exactly the kind of failure that is invisible until a
  // provider rejects the request, so it is checked rather than assumed.
  if (replacementBytes > policy.maxInlineBytes) {
    return {
      spilled: false,
      originalBytes,
      replacementBytes,
      skipReason: `internal: replacement (${replacementBytes}B) exceeded the cap (${policy.maxInlineBytes}B)`,
    };
  }

  // Never grow. Also covers the case where a tiny original is longer than the
  // notice that would replace it.
  if (replacementBytes >= originalBytes) {
    return {
      spilled: false,
      originalBytes,
      replacementBytes,
      skipReason: "replacement would not be smaller than the original",
    };
  }

  return { spilled: true, content: replacement, path, originalBytes, replacementBytes };
}

/**
 * Take the first and last bytes of `text` within `budget`, split on line
 * boundaries where possible.
 *
 * Line-aware because tool output is line-oriented and a preview that starts
 * mid-token reads as corruption. Byte-budgeted rather than character-budgeted
 * because the cap is a wire-size cap; slicing is done on whole code points so a
 * surrogate pair is never split.
 */
export function headTail(text: string, budget: number, headRatio: number): string {
  if (budget <= 0) return "";
  if (Buffer.byteLength(text, "utf8") <= budget) return text;

  const sep = "\n…\n";
  const sepBytes = Buffer.byteLength(sep, "utf8");

  // Reserve the separator before splitting, so head and tail shrink to fit
  // rather than the total overflowing. An earlier version budgeted head and
  // tail from the full amount and fell back to dropping the tail whenever they
  // collided — which silently discarded the end of the output at exactly the
  // tight budgets where the tail is most likely to hold the outcome.
  const contentBudget = budget - sepBytes;
  if (contentBudget <= 0) return takeBytes(text, budget, "start");

  const headBudget = Math.floor(contentBudget * headRatio);
  const tailBudget = contentBudget - headBudget;

  return takeBytes(text, headBudget, "start") + sep + takeBytes(text, tailBudget, "end");
}

/** Slice whole code points up to `bytes`, preferring a line boundary. */
function takeBytes(text: string, bytes: number, from: "start" | "end"): string {
  if (bytes <= 0) return "";
  const chars = [...text];
  let used = 0;
  const taken: string[] = [];

  const iter = from === "start" ? chars : [...chars].reverse();
  for (const ch of iter) {
    const size = Buffer.byteLength(ch, "utf8");
    if (used + size > bytes) break;
    used += size;
    taken.push(ch);
  }
  const slice = from === "start" ? taken.join("") : taken.reverse().join("");

  // Trim to a line boundary so the preview does not start or end mid-line,
  // but only if that leaves something substantial.
  if (from === "start") {
    const cut = slice.lastIndexOf("\n");
    return cut > slice.length * 0.5 ? slice.slice(0, cut) : slice;
  }
  const cut = slice.indexOf("\n");
  return cut >= 0 && cut < slice.length * 0.5 ? slice.slice(cut + 1) : slice;
}
