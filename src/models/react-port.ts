import type {
  ChatMessage,
  CompletionRequest,
  CompletionResult,
  ModelInfo,
  ModelPort,
  ToolSpec,
} from "../core/types.js";
import {
  REACT_STOP,
  reactProtocol,
  parseReact,
  reactCorrection,
  FINAL_ANSWER_MARKER,
} from "../steps/react.js";

/**
 * Adapts a text-only model into one that looks native to the loop.
 *
 * This is deliberately a **port wrapper rather than a branch in the loop**, and
 * that choice is the whole design. FE!N's claim is that a model is a plugin
 * behind one interface; the moment the loop has to ask "is this a ReAct model?"
 * that claim is false, and every future dialect adds another branch to the one
 * piece of code that must stay legible.
 *
 * So the loop never learns ReAct exists. It sends a `CompletionRequest` with
 * tools and gets back structured `toolCalls`. Underneath, this port:
 *
 *   1. moves the tool schemas out of the request and into the system prompt,
 *   2. rewrites the message history into the Thought/Action/Observation
 *      transcript the model speaks,
 *   3. stops generation before the model can invent an Observation,
 *   4. parses the reply back into structured calls,
 *   5. retries locally on malformed output, so the loop never sees a mess.
 *
 * Everything else — the lens, the ledger, prefix monotonicity, spill, digest,
 * subagents — works unchanged, because none of them can tell the difference.
 *
 * ## Why history has to be rewritten
 *
 * The subtle half. The transcript stores structured calls, but a ReAct model
 * must see its *own* prior turns in the format it produced them. Show it a
 * history it could not have written and coherence collapses within a few steps:
 * it stops matching the format, because the evidence in front of it says the
 * format is optional. Rewriting is not cosmetic — it is what makes multi-step
 * ReAct hold together.
 *
 * The rewrite is a pure function of the message list, so it is deterministic and
 * the prefix stays stable turn over turn. Cache discipline survives.
 */

export interface ReactPortOptions {
  /** Retries on unparseable output before giving up. */
  maxRepairs?: number;
  /** Override the id reported to the ledger. */
  id?: string;
}

export class ReactPort implements ModelPort {
  readonly info: ModelInfo;

  constructor(
    private readonly inner: ModelPort,
    private readonly opts: ReactPortOptions = {},
  ) {
    this.info = {
      ...inner.info,
      id: opts.id ?? inner.info.id,
      // To everything upstream this port speaks native tool calling. That is
      // the point of the wrapper.
      toolDialect: "native",
    };
  }

  async complete(req: CompletionRequest, signal?: AbortSignal): Promise<CompletionResult> {
    const tools = req.tools ?? [];
    const started = Date.now();

    const system = tools.length
      ? `${req.system}\n\n${reactProtocol(tools)}`
      : req.system;

    let messages = toReactTranscript(req.messages);
    let attempt = 0;
    const maxRepairs = this.opts.maxRepairs ?? 2;
    let inTok = 0;
    let outTok = 0;
    let cacheRead = 0;
    let cacheWrite = 0;

    for (;;) {
      const result = await this.inner.complete(
        {
          system,
          messages,
          // Tools live in the prompt now. Passing them again would make a
          // provider that *does* support tool calling emit both dialects.
          ...(req.maxTokens !== undefined ? { maxTokens: req.maxTokens } : {}),
          ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
          stop: [...(req.stop ?? []), ...REACT_STOP],
          ...(req.cacheAnchors ? { cacheAnchors: req.cacheAnchors } : {}),
        },
        signal,
      );

      // Repairs are real inference and must be billed, or the ledger would
      // under-report exactly the model that needed the most attempts.
      inTok += result.usage.inputTokens;
      outTok += result.usage.outputTokens;
      cacheRead += result.usage.cacheReadTokens;
      cacheWrite += result.usage.cacheWriteTokens;

      const step = parseReact(result.text, tools, this.info.id);

      if (!step.malformed || attempt >= maxRepairs) {
        // Out of repairs: surface the raw text as an answer rather than
        // throwing. A confused reply the user can read beats an exception, and
        // the loop's own step limit is the real backstop.
        const text = step.finalAnswer ?? (step.malformed ? result.text.trim() : "");
        return {
          text,
          toolCalls: step.toolCalls,
          ...(step.reasoning.length ? { reasoning: step.reasoning } : {}),
          usage: {
            inputTokens: inTok,
            outputTokens: outTok,
            cacheReadTokens: cacheRead,
            cacheWriteTokens: cacheWrite,
          },
          latencyMs: Date.now() - started,
          raw: result.raw,
        };
      }

      // Repair in place. The correction and the bad reply stay inside this
      // port, so the loop's transcript — and the driver's cached prefix — never
      // learn the model fumbled.
      attempt++;
      messages = [
        ...messages,
        { role: "assistant", content: result.text },
        { role: "user", content: reactCorrection(step.malformed) },
      ];
    }
  }
}

/**
 * Rewrite structured history into the transcript a ReAct model produced.
 *
 * Tool results become `Observation:` because that is the token the model was
 * told to expect and the one generation stops before. Feeding results back in
 * any other shape teaches it that Observations arrive in arbitrary formats,
 * which is precisely the drift the protocol exists to prevent.
 */
export function toReactTranscript(messages: ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];

  for (const m of messages) {
    switch (m.role) {
      case "system":
      case "user":
        out.push(m);
        break;

      case "assistant": {
        const parts: string[] = [];
        const thought = m.reasoning?.map((r) => r.text).filter(Boolean).join("\n");
        if (thought) parts.push(`Thought: ${thought}`);

        if (m.toolCalls?.length) {
          // One action per turn is the protocol. If history somehow holds more
          // (a native model's turn replayed to a ReAct model), keep the first
          // and drop the rest rather than teaching a format we forbid.
          const call = m.toolCalls[0]!;
          if (!thought && m.content) parts.push(`Thought: ${m.content}`);
          parts.push(`Action: ${call.name}`);
          parts.push(`Action Input: ${JSON.stringify(call.args)}`);
        } else if (m.content) {
          parts.push(`${FINAL_ANSWER_MARKER} ${m.content}`);
        }

        out.push({ role: "assistant", content: parts.join("\n") });
        break;
      }

      case "tool": {
        // Results are folded into one user turn: the model expects a single
        // Observation, and several in a row would imply several actions.
        const body = m.results
          .map((r) => (r.isError ? `Error: ${r.content}` : r.content))
          .join("\n");
        out.push({ role: "user", content: `Observation: ${body}` });
        break;
      }
    }
  }

  return mergeAdjacentUsers(out);
}

/**
 * Collapse consecutive user turns.
 *
 * Some providers reject two user messages in a row, and an Observation
 * following a user instruction produces exactly that. Merging is safe because
 * both halves are addressed to the model in the same breath.
 */
function mergeAdjacentUsers(messages: ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const m of messages) {
    const prev = out[out.length - 1];
    if (m.role === "user" && prev?.role === "user") {
      out[out.length - 1] = { role: "user", content: `${prev.content}\n\n${m.content}` };
    } else {
      out.push(m);
    }
  }
  return out;
}

/** Convenience: wrap a port only when it needs it. */
export function asReact(port: ModelPort, opts?: ReactPortOptions): ModelPort {
  return port.info.toolDialect === "react" ? new ReactPort(port, opts) : port;
}

export type { ToolSpec };
