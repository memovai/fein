import { AnthropicPort } from "../models/providers/anthropic.js";
import { OpenAICompatPort } from "../models/providers/openai.js";
import { OllamaPort } from "../models/providers/ollama.js";
import { Router } from "../models/router.js";
import { asReact } from "../models/react-port.js";
import type { ModelPort, StepName, ToolDialect } from "../core/types.js";

export interface PortConfig {
  id: string;
  kind: "anthropic" | "openai" | "ollama";
  model: string;
  baseUrl?: string;
  apiKeyEnv?: string;
  locality?: "local" | "cloud";
  toolDialect?: ToolDialect;
  costPerMTokIn?: number;
  costPerMTokOut?: number;
  contextWindow?: number;
}

export interface FeinConfig {
  ports: PortConfig[];
  /** slot -> port id, or [primary, ...fallbacks]. */
  bind: Partial<Record<StepName, string | string[]>>;
}

/**
 * Build a port, wrapping it in the ReAct adapter when it speaks that dialect.
 *
 * The wrap happens here rather than in the loop so that everything downstream —
 * router, ledger, lens, subagents — sees one uniform interface. A `react` port
 * is a native port from the outside; only this function knows otherwise.
 */
export function buildPort(cfg: PortConfig): ModelPort {
  return asReact(buildRawPort(cfg));
}

function buildRawPort(cfg: PortConfig): ModelPort {
  const apiKey = cfg.apiKeyEnv ? process.env[cfg.apiKeyEnv] : undefined;
  switch (cfg.kind) {
    case "anthropic":
      return new AnthropicPort({
        id: cfg.id,
        model: cfg.model,
        ...(apiKey !== undefined ? { apiKey } : {}),
        ...(cfg.baseUrl !== undefined ? { baseUrl: cfg.baseUrl } : {}),
        ...(cfg.costPerMTokIn !== undefined ? { costPerMTokIn: cfg.costPerMTokIn } : {}),
        ...(cfg.costPerMTokOut !== undefined ? { costPerMTokOut: cfg.costPerMTokOut } : {}),
        ...(cfg.contextWindow !== undefined ? { contextWindow: cfg.contextWindow } : {}),
      });
    case "ollama":
      return new OllamaPort({
        id: cfg.id,
        model: cfg.model,
        ...(cfg.baseUrl !== undefined ? { baseUrl: cfg.baseUrl } : {}),
        ...(cfg.toolDialect !== undefined ? { toolDialect: cfg.toolDialect } : {}),
        ...(cfg.contextWindow !== undefined ? { contextWindow: cfg.contextWindow } : {}),
      });
    case "openai":
      return new OpenAICompatPort({
        id: cfg.id,
        model: cfg.model,
        baseUrl: cfg.baseUrl ?? "https://api.openai.com/v1",
        ...(apiKey !== undefined ? { apiKey } : {}),
        locality: cfg.locality ?? "cloud",
        ...(cfg.toolDialect !== undefined ? { toolDialect: cfg.toolDialect } : {}),
        ...(cfg.costPerMTokIn !== undefined ? { costPerMTokIn: cfg.costPerMTokIn } : {}),
        ...(cfg.costPerMTokOut !== undefined ? { costPerMTokOut: cfg.costPerMTokOut } : {}),
        ...(cfg.contextWindow !== undefined ? { contextWindow: cfg.contextWindow } : {}),
      });
  }
}

export function buildRouter(cfg: FeinConfig): Router {
  const ports = new Map<string, ModelPort>();
  for (const p of cfg.ports) ports.set(p.id, buildPort(p));

  const router = new Router();
  for (const [slot, target] of Object.entries(cfg.bind)) {
    if (!target) continue;
    const ids = Array.isArray(target) ? target : [target];
    const chain = ids.map((id) => {
      const port = ports.get(id);
      if (!port) throw new Error(`slot "${slot}" references unknown port "${id}"`);
      return port;
    });
    const [primary, ...fallbacks] = chain;
    if (!primary) continue;
    router.bind(slot as StepName, primary, fallbacks.length ? { fallbacks } : {});
  }
  return router;
}

/**
 * The reference hybrid profile.
 *
 * Cloud model drives; a small local model does transcription and compression.
 * Verification is bound to the *cloud* driver rather than the local model:
 * the verifier only runs on side-effecting delegated calls, which are rare,
 * so its cost is negligible — and it is precisely the moment where you want
 * the more capable model looking. Cheap where it is safe to be cheap,
 * expensive exactly where being wrong is unrecoverable.
 */
export function hybridProfile(opts?: {
  cloudModel?: string;
  localModel?: string;
  ollamaUrl?: string;
}): FeinConfig {
  return {
    ports: [
      {
        id: "cloud",
        kind: "anthropic",
        model: opts?.cloudModel ?? "claude-sonnet-5",
        apiKeyEnv: "ANTHROPIC_API_KEY",
        costPerMTokIn: 3,
        costPerMTokOut: 15,
        contextWindow: 200_000,
      },
      {
        id: "local",
        kind: "ollama",
        model: opts?.localModel ?? "qwen2.5:3b",
        ...(opts?.ollamaUrl !== undefined ? { baseUrl: opts.ollamaUrl } : {}),
        toolDialect: "json",
        contextWindow: 32_768,
      },
    ],
    bind: {
      driver: "cloud",
      // Local first; if the local runtime is down, the driver absorbs the job.
      digester: ["local", "cloud"],
      verifier: "cloud",
      titler: ["local", "cloud"],
    },
  };
}

/** All-cloud: the control condition. Same loop, no local models. */
export function cloudOnlyProfile(model = "claude-sonnet-5"): FeinConfig {
  return {
    ports: [
      {
        id: "cloud",
        kind: "anthropic",
        model,
        apiKeyEnv: "ANTHROPIC_API_KEY",
        costPerMTokIn: 3,
        costPerMTokOut: 15,
        contextWindow: 200_000,
      },
    ],
    bind: { driver: "cloud", digester: "cloud", verifier: "cloud", titler: "cloud" },
  };
}

/**
 * All-local: no network at all.
 *
 * The driver speaks **ReAct**, not native tool calling. That is not a stylistic
 * preference — it is what makes this profile work at all. Small models drive a
 * tool-calling API badly (omitted fields, invented parameter names, format lost
 * by step four), and the failures are silent. In ReAct the same sloppiness
 * becomes a parse error the harness repairs locally, and the format is in every
 * model's training data.
 */
export function localOnlyProfile(model = "qwen2.5:7b", baseUrl?: string): FeinConfig {
  return {
    ports: [
      {
        id: "local",
        kind: "ollama",
        model,
        ...(baseUrl !== undefined ? { baseUrl } : {}),
        toolDialect: "react",
        contextWindow: 32_768,
      },
    ],
    bind: { driver: "local", digester: "local", verifier: "local", titler: "local" },
  };
}
