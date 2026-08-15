import { readErrorBody } from "./http.js";
import type {
  ToolDialect,
  ChatMessage,
  CompletionRequest,
  CompletionResult,
  ModelInfo,
  ModelPort,
  ToolCall,
} from "../../core/types.js";
import { parseJsonToolCalls } from "./openai.js";

/**
 * Ollama native /api/chat.
 *
 * Ollama is the most likely local runtime on a developer laptop, and it has a
 * property that matters enormously for hybrid work: it keeps a model resident
 * with its KV cache warm between calls (`keep_alive`), and llama.cpp
 * underneath does prefix reuse. So the *local* side of FE!N benefits from the
 * same render-monotonicity discipline as the cloud side — a stable prefix
 * means the local model reprocesses only the delta, which is the difference
 * between a 200ms delegation and a 4s one on a small model.
 *
 * We default keep_alive to a long window precisely so the small model stays
 * loaded across a session; unloading and reloading a 3B model costs more wall
 * clock than every delegation it will serve.
 */
export interface OllamaOptions {
  id: string;
  model: string;
  baseUrl?: string;
  contextWindow?: number;
  toolDialect?: ToolDialect;
  keepAlive?: string;
  numCtx?: number;
}

export class OllamaPort implements ModelPort {
  readonly info: ModelInfo;

  constructor(private readonly opts: OllamaOptions) {
    this.info = {
      id: opts.id,
      provider: "ollama",
      model: opts.model,
      locality: "local",
      toolDialect: opts.toolDialect ?? "native",
      costPerMTokIn: 0,
      costPerMTokOut: 0,
      contextWindow: opts.contextWindow ?? 32_768,
    };
  }

  async complete(req: CompletionRequest, signal?: AbortSignal): Promise<CompletionResult> {
    const started = Date.now();
    const body: Record<string, unknown> = {
      model: this.opts.model,
      messages: [{ role: "system", content: req.system }, ...req.messages.flatMap(toOllamaMessage)],
      stream: false,
      keep_alive: this.opts.keepAlive ?? "30m",
      options: {
        temperature: req.temperature ?? 0,
        num_predict: req.maxTokens ?? 1024,
        ...(this.opts.numCtx ? { num_ctx: this.opts.numCtx } : {}),
        ...(req.stop?.length ? { stop: req.stop } : {}),
      },
    };
    if (req.tools?.length && this.info.toolDialect === "native") {
      body["tools"] = req.tools.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
    }

    const res = await fetch(`${(this.opts.baseUrl ?? "http://127.0.0.1:11434").replace(/\/$/, "")}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: signal ?? null,
    });
    if (!res.ok) {
      throw new Error(`${this.info.id}: HTTP ${res.status} ${await readErrorBody(res)}`);
    }
    const json = (await res.json()) as OllamaResponse;
    const text = json.message?.content ?? "";
    const native = (json.message?.tool_calls ?? []).map(
      (tc, i): ToolCall => ({
        id: `ollama_${i}_${tc.function.name}`,
        name: tc.function.name,
        args: (tc.function.arguments as Record<string, unknown>) ?? {},
      }),
    );

    return {
      text,
      toolCalls: native.length > 0 ? native : parseJsonToolCalls(text),
      usage: {
        inputTokens: json.prompt_eval_count ?? 0,
        outputTokens: json.eval_count ?? 0,
        // Ollama reports prompt_eval_count as *newly evaluated* prompt tokens;
        // cached prefix tokens are simply absent from that count, so we cannot
        // observe them directly. Left at 0 rather than guessed.
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
      latencyMs: Date.now() - started,
      raw: json,
    };
  }
}

interface OllamaResponse {
  message?: {
    content?: string;
    tool_calls?: Array<{ function: { name: string; arguments: unknown } }>;
  };
  prompt_eval_count?: number;
  eval_count?: number;
}

function toOllamaMessage(m: ChatMessage): unknown[] {
  switch (m.role) {
    case "system":
      if (m.toolChanges?.length) {
        return [
          {
            role: "system",
            content: m.toolChanges
              .map((c) =>
                c.op === "add"
                  ? `The tool \`${c.tool}\` is now available.`
                  : `The tool \`${c.tool}\` is no longer available; do not call it.`,
              )
              .join(" "),
          },
        ];
      }
      return [{ role: "system", content: m.content }];
    case "user":
      return [{ role: m.role, content: m.content }];
    case "assistant":
      return [
        {
          role: "assistant",
          content: m.content,
          ...(m.toolCalls?.length
            ? {
                tool_calls: m.toolCalls.map((tc) => ({
                  function: { name: tc.name, arguments: tc.args },
                })),
              }
            : {}),
        },
      ];
    case "tool":
      return m.results.map((r) => ({ role: "tool", content: r.content }));
  }
}
