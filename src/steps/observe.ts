import type { Router } from "../models/router.js";
import type { Ledger } from "../telemetry/ledger.js";
import type { Transcript } from "../core/transcript.js";
import { DIGESTER_SYSTEM } from "./prompts.js";
import { estimateTokens } from "../models/providers/scripted.js";
import type { RouteHints, ToolResult } from "../core/types.js";

export interface DigestPolicy {
  /** Only digest results longer than this many estimated tokens. */
  minTokens: number;
  /** Target size of the digest, in tokens. */
  targetTokens: number;
  /** Never digest results from these tools (output is already dense). */
  never?: string[];
  /** Never digest errors — the think model needs the exact failure text. */
  keepErrorsVerbatim: boolean;
  /**
   * Most chunks to summarize when the input does not fit the observe model's window.
   *
   * A cap rather than "however many it takes" because the marginal value falls
   * off fast — the twentieth chunk of a routine log rarely holds the thing you
   * needed — while the cost does not.
   *
   * But *which* cost depends on where the observe model runs, so the default does
   * too. A local model is free at the margin: the only price of another chunk
   * is wall-clock on hardware you already own, so it can afford to read most of
   * a large log. A cloud observe model is billed per chunk, and an observe model that
   * spends real money to summarize a log is competing with simply not reading
   * it. Set explicitly to override either.
   */
  maxChunks?: number;
}

export const DEFAULT_DIGEST_POLICY: DigestPolicy = {
  minTokens: 800,
  targetTokens: 200,
  never: [],
  keepErrorsVerbatim: true,
  // Left unset: resolved per call from where the observe model actually runs.
};

/**
 * Chunk cap when the policy does not pin one.
 *
 * `1` for cloud is not a typo, and the reasoning only becomes visible once
 * spill exists alongside this:
 *
 * Spill already bounds an oversized result to a few KB, for free, losslessly,
 * with a retrieval path. So a digest of a huge result is not competing against
 * 200k raw tokens in the think model's context — it is competing against an 8KB
 * preview that cost nothing. Its marginal benefit is the difference between a
 * preview and a summary: real, but worth a few hundred tokens per turn.
 *
 * Against that, chunked cloud digestion of a 200k log is several full-price
 * calls — measured at ~$0.24 for four chunks. That needs dozens of turns to
 * repay, and the session usually ends first.
 *
 * A *local* observe model has no such problem: the marginal cost is wall-clock on
 * hardware already paid for, so it can read the whole thing. This is the
 * clearest case in the codebase where the same operation is obviously worth it
 * locally and obviously not worth it in the cloud — which is the entire hybrid
 * argument in one constant.
 */
export function defaultMaxChunks(locality: "local" | "cloud"): number {
  return locality === "local" ? 16 : 1;
}

export interface DigestOutcome {
  digested: boolean;
  text?: string;
  servedBy?: string;
  originalTokens: number;
  digestTokens?: number;
  skipReason?: string;
  /** True when a routing policy diverted this digest off the default port. */
  escalated?: boolean;
}

/**
 * The observe model compresses bulky tool output on the local machine before it
 * ever reaches the cloud think model's context.
 *
 * The economics are the point. A 20k-token file listing costs cloud input
 * tokens once — and then again on every subsequent turn of the session, since
 * it sits in the prompt prefix forever. Prompt caching makes those repeats
 * cheap (0.1x) but not free, and they still consume context window, which is
 * the genuinely scarce resource. Compressing 20k to 200 locally is therefore
 * a permanent saving multiplied by the remaining length of the session, and a
 * permanent reclamation of context.
 *
 * Three rules keep this from being a footgun:
 *
 *  1. **Errors are never digested.** A summarized stack trace is a debugging
 *     disaster. The exact bytes matter precisely when things went wrong.
 *
 *  2. **The raw output is retained in the transcript.** The digest is a view,
 *     not a deletion. Anything the think model needs can be re-fetched, and a human
 *     auditing the session sees exactly what the tool actually returned.
 *
 *  3. **Digest before first render, never after.** Substituting a digest for
 *     output the think model has already seen would rewrite its prompt prefix and
 *     throw away the entire KV cache to save a few hundred tokens — a trade
 *     that is almost always negative. MainLens enforces this by freezing
 *     events once rendered; this function is called on the ingest path, before
 *     the think model's next render, which is the only moment substitution is free.
 */
export async function digest(args: {
  router: Router;
  ledger: Ledger;
  transcript: Transcript;
  result: ToolResult;
  toolName: string;
  policy?: DigestPolicy;
  signal?: AbortSignal;
}): Promise<DigestOutcome> {
  const policy = args.policy ?? DEFAULT_DIGEST_POLICY;
  const originalTokens = estimateTokens(args.result.content);

  if (policy.keepErrorsVerbatim && args.result.isError) {
    return { digested: false, originalTokens, skipReason: "error output kept verbatim" };
  }
  if (policy.never?.includes(args.toolName)) {
    return { digested: false, originalTokens, skipReason: `tool "${args.toolName}" is exempt` };
  }
  if (originalTokens < policy.minTokens) {
    return { digested: false, originalTokens, skipReason: "below size threshold" };
  }
  if (!args.router.has("observe")) {
    return { digested: false, originalTokens, skipReason: "no observe model bound" };
  }

  const channel = args.transcript.newSideChannel("digest");

  // Facts for the observe binding's routing policy (if one is bound): a
  // right-sizing policy sends small digests to a small model on this hint.
  // Passing the same hints to portFor and run keeps budget and executor agreed.
  const hints: RouteHints = { approxInputTokens: originalTokens };

  // Respect the observe model's context window.
  //
  // Without this the observe model sends the whole result to whatever model is
  // bound. A 200k-token log to a 32k local model fails, falls back to the
  // cloud, and sends 200k tokens there — spending real money to *save* tokens,
  // which is the exact inverse of the point. The window is the budget.
  const port = args.router.portFor("observe", hints);
  const window = port.info.contextWindow;
  // Leave room for the instructions and the reply. Two thirds is deliberately
  // conservative: an underfilled chunk costs one extra call, an overfilled one
  // costs a hard failure and a fallback to the expensive model.
  const chunkBudget = Math.max(1000, Math.floor((window * 2) / 3) - policy.targetTokens);

  const maxChunks = policy.maxChunks ?? defaultMaxChunks(port.info.locality);
  const chunks = chunkByLines(args.result.content, chunkBudget);

  // A cloud observe model facing a result too large for one call: don't. Spill has
  // already bounded what the think model sees, so paying several full-price calls
  // buys the difference between a preview and a summary — which does not repay
  // within a normal session. Bind a local observe model, or pin `maxChunks` to say
  // you meant it.
  if (chunks.length > maxChunks && port.info.locality === "cloud" && policy.maxChunks === undefined) {
    return {
      digested: false,
      originalTokens,
      skipReason:
        `too large for one cloud call (${chunks.length} chunks needed) — spill already bounds ` +
        `what the think model sees, so chunked cloud digestion would cost more than it saves. ` +
        `Bind a local observe model, or set maxChunks explicitly.`,
    };
  }

  const used = chunks.slice(0, maxChunks);
  const skipped = chunks.length - used.length;

  let text: string;
  let servedBy: string;
  let escalated = false;

  if (used.length === 1) {
    const one = await runDigest(args, channel, {
      body: used[0]!,
      instruction: `Output of tool \`${args.toolName}\`. Compress to roughly ${policy.targetTokens} tokens.`,
      maxTokens: Math.ceil(policy.targetTokens * 1.5),
    }, hints);
    text = one.text;
    servedBy = one.servedBy;
    escalated = one.escalated;
  } else {
    // Map: each chunk is summarized against the same anomaly-preserving rules.
    // Sequential rather than parallel — these run on one local model, and
    // firing six requests at a 3B model at once makes all six slower.
    const partials: string[] = [];
    for (let i = 0; i < used.length; i++) {
      const part = await runDigest(args, channel, {
        body: used[i]!,
        instruction:
          `Part ${i + 1} of ${used.length} of the output of tool \`${args.toolName}\`. ` +
          `Compress this part alone to roughly ${Math.ceil(policy.targetTokens / 2)} tokens. ` +
          `You are seeing a fragment: do not guess at what came before or after.`,
        maxTokens: policy.targetTokens,
      }, hints);
      partials.push(part.text);
      servedBy = part.servedBy;
    }

    // Reduce. The risk here is the one that makes recursive summarization
    // dangerous — a second pass smoothing away the single anomalous line the
    // first pass correctly kept. So the merge is told its job is to join, not
    // to summarize again.
    const merged = await runDigest(args, channel, {
      body: partials.map((t, i) => `--- part ${i + 1} ---\n${t}`).join("\n\n"),
      instruction:
        `These are ${used.length} partial summaries of one tool output, in order. Combine them ` +
        `into a single summary of roughly ${policy.targetTokens} tokens. Preserve every ` +
        `specific finding, failure, and identifier the parts recorded — your job is to join ` +
        `them, not to summarize them again. Do not add anything the parts do not say.`,
      maxTokens: Math.ceil(policy.targetTokens * 1.5),
    }, hints);
    text = merged.text;
    servedBy = merged.servedBy;
  }

  if (skipped > 0) {
    // Silence here would read as "this summarizes everything", which is how an
    // agent concludes something is absent when it simply was not read.
    text += `\n\n[${skipped} further section(s) of this output were not summarized; the full text is retained.]`;
  }

  const result = { text };

  const digestTokens = estimateTokens(result.text);

  // A digest that isn't meaningfully smaller is a net loss: we paid for the
  // call and gained nothing, and the think model now reads a paraphrase instead of
  // the truth. Keep the original — unless a routing policy offers a stronger
  // port, in which case the gate doubles as the cascade's scorer: try cheap,
  // judge, escalate once.
  if (digestTokens >= originalTokens * 0.7) {
    const retry = await escalateReject(args, channel, policy, hints, originalTokens);
    if (retry) return retry;
    return {
      digested: false,
      originalTokens,
      digestTokens,
      servedBy,
      skipReason: "digest was not meaningfully smaller than the original",
    };
  }

  return { digested: true, text: result.text, servedBy, originalTokens, digestTokens, escalated };
}

/**
 * One escalation retry after the quality gate rejected the default port's
 * digest. Only when the observe binding carries a policy that actually
 * reroutes under "reject" pressure, and only when the whole input fits the
 * escalation port in ONE call — escalating a 16-chunk log to the cloud would
 * contradict the priced economics in `defaultMaxChunks`, so it never happens
 * implicitly. Both attempts are billed; that is the cascade's honest price.
 */
async function escalateReject(
  args: {
    router: Router;
    ledger: Ledger;
    transcript: Transcript;
    result: ToolResult;
    toolName: string;
    signal?: AbortSignal;
  },
  channel: string,
  policy: DigestPolicy,
  baseHints: RouteHints,
  originalTokens: number,
): Promise<DigestOutcome | undefined> {
  if (!args.router.binding("observe").policy) return undefined;

  const hints: RouteHints = { ...baseHints, pressure: "reject", pressureCount: 1 };
  const port = args.router.portFor("observe", hints);
  if (port === args.router.binding("observe").port) return undefined; // policy declined

  const budget = Math.max(1000, Math.floor((port.info.contextWindow * 2) / 3) - policy.targetTokens);
  if (chunkByLines(args.result.content, budget).length > 1) return undefined;

  const one = await runDigest(args, channel, {
    body: args.result.content,
    instruction: `Output of tool \`${args.toolName}\`. Compress to roughly ${policy.targetTokens} tokens.`,
    maxTokens: Math.ceil(policy.targetTokens * 1.5),
  }, hints);

  const digestTokens = estimateTokens(one.text);
  if (digestTokens >= originalTokens * 0.7) return undefined; // still bloated: keep the original
  return {
    digested: true,
    text: one.text,
    servedBy: one.servedBy,
    originalTokens,
    digestTokens,
    escalated: true,
  };
}

/** One digest call, billed and logged to the side channel. */
async function runDigest(
  args: {
    router: Router;
    ledger: Ledger;
    transcript: Transcript;
    signal?: AbortSignal;
  },
  channel: string,
  req: { body: string; instruction: string; maxTokens: number },
  hints?: RouteHints,
): Promise<{ text: string; servedBy: string; escalated: boolean }> {
  const { result, port, decision } = await args.router.run(
    "observe",
    {
      system: DIGESTER_SYSTEM,
      messages: [{ role: "user", content: `${req.instruction}\n\n---\n${req.body}` }],
      maxTokens: req.maxTokens,
      temperature: 0,
    },
    args.signal,
    hints,
  );
  args.ledger.record("observe", port.info, result, undefined, decision);
  args.transcript.assistant(result.text, [], `observe@${port.info.id}`, channel);
  return { text: result.text, servedBy: port.info.id, escalated: decision?.escalated ?? false };
}

/**
 * Split text into pieces that fit a token budget, on line boundaries.
 *
 * Line-aware because tool output is line-oriented: a chunk boundary mid-line
 * gives two fragments that each look like corruption to whatever reads them. A
 * single line longer than the budget is emitted whole rather than cut — one
 * oversized chunk is a bounded problem, a mangled line is an unbounded one.
 */
export function chunkByLines(text: string, budgetTokens: number): string[] {
  if (estimateTokens(text) <= budgetTokens) return [text];

  const chunks: string[] = [];
  let current: string[] = [];
  let currentTokens = 0;

  for (const line of text.split("\n")) {
    const lineTokens = estimateTokens(line) + 1;
    if (currentTokens + lineTokens > budgetTokens && current.length > 0) {
      chunks.push(current.join("\n"));
      current = [];
      currentTokens = 0;
    }
    current.push(line);
    currentTokens += lineTokens;
  }
  if (current.length > 0) chunks.push(current.join("\n"));
  return chunks;
}
