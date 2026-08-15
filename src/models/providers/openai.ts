import { readErrorBody } from "./http.js";
import type {
  ToolDialect,
  ChatMessage,
  CompletionRequest,
  CompletionResult,
  ModelInfo,
  ModelPort,
  ToolCall,
  ToolSpec,
} from "../../core/types.js";

/**
 * OpenAI-compatible provider.
 *
 * This single adapter covers a surprising amount of the hybrid landscape:
 * OpenAI itself, DeepSeek, Together, Groq, vLLM, llama.cpp's server, LM
 * Studio, and Ollama's /v1 shim all speak this wire format. Locality and
 * pricing are declared by the caller, not sniffed, because the same wire
 * format says nothing about where the weights actually live.
 *
 * Cache note: OpenAI-family providers do *implicit* prefix caching — there is
 * no cache_control to place. The only thing a harness can do to earn hits is
 * keep the prompt prefix byte-identical across turns, which is exactly what
 * MainLens + PrefixGuard enforce. We surface `prompt_tokens_details.
 * cached_tokens` when the provider reports it so the ledger can verify we
 * actually earned the hits we designed for.
 */
export interface OpenAICompatOptions {
  id: string;
  baseUrl: string;
  model: string;
  apiKey?: string;
  locality: "local" | "cloud";
  contextWindow?: number;
  costPerMTokIn?: number;
  costPerMTokOut?: number;
  /** Some small local models do better with JSON-in-text than native tools. */
  toolDialect?: ToolDialect;
  headers?: Record<string, string>;
}

export class OpenAICompatPort implements ModelPort {
  readonly info: ModelInfo;

  constructor(private readonly opts: OpenAICompatOptions) {
    this.info = {
      id: opts.id,
      provider: "openai-compat",
      model: opts.model,
      locality: opts.locality,
      toolDialect: opts.toolDialect ?? "native",
      costPerMTokIn: opts.costPerMTokIn ?? 0,
      costPerMTokOut: opts.costPerMTokOut ?? 0,
      contextWindow: opts.contextWindow ?? 128_000,
    };
  }

  async complete(req: CompletionRequest, signal?: AbortSignal): Promise<CompletionResult> {
    const started = Date.now();
    const body: Record<string, unknown> = {
      model: this.opts.model,
      messages: toOpenAIMessages(req),
      max_tokens: req.maxTokens ?? 2048,
      temperature: req.temperature ?? 0,
    };
    if (req.stop?.length) body["stop"] = req.stop;
    // Providers that shard their cache route on this. Sending a stable value
    // keeps successive turns of one conversation on a machine that already
    // holds the prefix; sending nothing leaves it to chance.
    if (req.cacheScope) body["prompt_cache_key"] = req.cacheScope;
    if (req.tools?.length && this.info.toolDialect === "native") {
      body["tools"] = req.tools.map(toOpenAITool);
    }

    const res = await fetch(`${this.opts.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.opts.apiKey ? { authorization: `Bearer ${this.opts.apiKey}` } : {}),
        ...this.opts.headers,
      },
      body: JSON.stringify(body),
      signal: signal ?? null,
    });

    if (!res.ok) {
      throw new Error(`${this.info.id}: HTTP ${res.status} ${await readErrorBody(res)}`);
    }
    const json = (await res.json()) as OpenAIResponse;
    const choice = json.choices?.[0];
    const text = choice?.message?.content ?? "";
    const native = (choice?.message?.tool_calls ?? []).map(
      (tc): ToolCall => ({
        id: tc.id,
        name: tc.function.name,
        args: safeParseArgs(tc.function.arguments),
      }),
    );
    const toolCalls =
      this.info.toolDialect === "json" && native.length === 0 ? parseJsonToolCalls(text) : native;

    return {
      text,
      toolCalls,
      usage: {
        inputTokens: json.usage?.prompt_tokens ?? 0,
        outputTokens: json.usage?.completion_tokens ?? 0,
        cacheReadTokens: json.usage?.prompt_tokens_details?.cached_tokens ?? 0,
        cacheWriteTokens: 0,
      },
      latencyMs: Date.now() - started,
      raw: json,
    };
  }
}

interface OpenAIResponse {
  choices?: Array<{
    message?: {
      content?: string;
      tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
    };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
  };
}

function toOpenAITool(t: ToolSpec) {
  return {
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.parameters },
  };
}

function toOpenAIMessages(req: CompletionRequest): unknown[] {
  const out: unknown[] = [{ role: "system", content: req.system }];
  for (const m of req.messages) out.push(...toOpenAIMessage(m));
  return out;
}

function toOpenAIMessage(m: ChatMessage): unknown[] {
  switch (m.role) {
    case "system":
      // No mid-conversation tool-change primitive here. Degrade to a plain
      // system message describing the change rather than dropping it: the
      // model still needs to know the tool set moved, even if the provider
      // cannot enforce it structurally.
      if (m.toolChanges?.length) {
        const text = m.toolChanges
          .map((c) =>
            c.op === "add"
              ? `The tool \`${c.tool}\` is now available.`
              : `The tool \`${c.tool}\` is no longer available; do not call it.`,
          )
          .join(" ");
        return [{ role: "system", content: text }];
      }
      return [{ role: "system", content: m.content }];
    case "user":
      return [{ role: m.role, content: m.content }];
    case "assistant":
      return [
        {
          role: "assistant",
          content: m.content || null,
          ...(m.toolCalls?.length
            ? {
                tool_calls: m.toolCalls.map((tc) => ({
                  id: tc.id,
                  type: "function",
                  function: { name: tc.name, arguments: JSON.stringify(tc.args) },
                })),
              }
            : {}),
        },
      ];
    case "tool":
      return m.results.map((r) => ({
        role: "tool",
        tool_call_id: r.callId,
        content: r.content,
      }));
  }
}

function safeParseArgs(s: string): Record<string, unknown> {
  try {
    const v = JSON.parse(s);
    return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * Small local models frequently emit tool calls as prose-wrapped JSON rather
 * than native tool_calls. We accept the common shapes rather than demanding
 * the model behave — the whole premise of delegating to a 3B model is that
 * the harness absorbs its sloppiness.
 */
export function parseJsonToolCalls(text: string): ToolCall[] {
  const blocks = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map((m) => m[1]!);
  const candidates = blocks.length > 0 ? blocks : [text];
  const calls: ToolCall[] = [];
  for (const c of candidates) {
    const obj = tryJson(c) ?? tryJson(sliceBraces(c));
    if (!obj) continue;
    for (const item of Array.isArray(obj) ? obj : [obj]) {
      if (typeof item !== "object" || item === null) continue;
      const rec = item as Record<string, unknown>;
      const name = rec["name"] ?? rec["tool"] ?? rec["function"];
      const args = rec["arguments"] ?? rec["args"] ?? rec["parameters"] ?? {};
      if (typeof name === "string") {
        calls.push({
          id: `local_${calls.length}_${name}`,
          name,
          args: typeof args === "object" && args !== null ? (args as Record<string, unknown>) : {},
        });
      }
    }
  }
  return calls;
}

function tryJson(s: string): unknown {
  try {
    return JSON.parse(s.trim());
  } catch {
    return undefined;
  }
}

function sliceBraces(s: string): string {
  const a = s.indexOf("{");
  const b = s.lastIndexOf("}");
  return a >= 0 && b > a ? s.slice(a, b + 1) : "";
}
