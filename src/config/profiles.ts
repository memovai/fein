import { AnthropicPort } from "../models/providers/anthropic.js";
import { OpenAICompatPort } from "../models/providers/openai.js";
import { OllamaPort } from "../models/providers/ollama.js";
import { Router } from "../models/router.js";
import { asReact } from "../models/react-port.js";
import { escalateOnReject, escalateOnStuck, rightSize } from "../models/policy.js";
import type { ModelPort, RoutePolicy, StepName, ThinkingLevel, ToolDialect } from "../core/types.js";

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

/**
 * Adaptive routing, declared in config. Each kind maps to a factory in
 * models/policy.ts; see that file for what each policy does and refuses to do.
 */
export type PolicyConfig =
  | { kind: "escalate-on-stuck"; thinking?: ThinkingLevel[]; restartTo?: string }
  | { kind: "escalate-on-reject"; to: string }
  | { kind: "right-size"; small: string; maxInputTokens?: number };

/**
 * A slot's binding: a port id, `[primary, ...fallbacks]`, or the object form
 * when the binding carries a routing policy.
 */
export type BindTarget =
  | string
  | string[]
  | { port: string; fallbacks?: string[]; policy?: PolicyConfig };

export interface FeinConfig {
  ports: PortConfig[];
  /** slot -> port id, [primary, ...fallbacks], or the object form with a policy. */
  bind: Partial<Record<StepName, BindTarget>>;
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

  const resolve = (slot: string, id: string): ModelPort => {
    const port = ports.get(id);
    if (!port) throw new Error(`slot "${slot}" references unknown port "${id}"`);
    return port;
  };

  const router = new Router();
  for (const [slot, target] of Object.entries(cfg.bind)) {
    if (!target) continue;
    const obj = typeof target === "string" || Array.isArray(target) ? undefined : target;
    const ids = obj
      ? [obj.port, ...(obj.fallbacks ?? [])]
      : Array.isArray(target)
        ? target
        : [target as string];
    const chain = ids.map((id) => resolve(slot, id));
    const [primary, ...fallbacks] = chain;
    if (!primary) continue;

    let policy: RoutePolicy | undefined;
    if (obj?.policy) {
      const p = obj.policy;
      switch (p.kind) {
        case "escalate-on-stuck": {
          const restartTo = p.restartTo !== undefined ? resolve(slot, p.restartTo) : undefined;
          policy = escalateOnStuck({
            ...(p.thinking ? { ladder: p.thinking } : {}),
            ...(restartTo ? { restartTo } : {}),
          });
          if (restartTo && restartTo !== primary && !fallbacks.includes(restartTo)) {
            fallbacks.push(restartTo);
          }
          break;
        }
        case "escalate-on-reject": {
          const to = resolve(slot, p.to);
          policy = escalateOnReject({ to });
          // The router refuses a policy that picks a port outside the declared
          // chain, so the target must be reachable as a fallback.
          if (to !== primary && !fallbacks.includes(to)) fallbacks.push(to);
          break;
        }
        case "right-size": {
          const small = resolve(slot, p.small);
          policy = rightSize({
            small,
            ...(p.maxInputTokens !== undefined ? { maxInputTokens: p.maxInputTokens } : {}),
          });
          if (small !== primary && !fallbacks.includes(small)) fallbacks.push(small);
          break;
        }
      }
    }

    router.bind(slot as StepName, primary, {
      ...(fallbacks.length ? { fallbacks } : {}),
      ...(policy ? { policy } : {}),
    });
  }
  return router;
}

/**
 * The reference hybrid profile.
 *
 * Cloud model drives; a small local model does transcription and compression.
 * Verification is bound to the *cloud* think model rather than the local model:
 * the verify model only runs on side-effecting delegated calls, which are rare,
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
      think: "cloud",
      // Local first; if the local runtime is down, the think model absorbs the job.
      observe: ["local", "cloud"],
      verify: "cloud",
      title: ["local", "cloud"],
      // Adaptive routing is opt-in via the object form, e.g.:
      //   think:   { port: "cloud", policy: { kind: "escalate-on-stuck" } }
      //     (guard fires -> same port, higher thinking effort; never a port swap)
      //   observe: { port: "local", policy: { kind: "escalate-on-reject", to: "cloud" } }
      //     (bloated local digest -> one cloud retry; the quality gate is the scorer)
      // The defaults stay static: adaptive behaviour should be something you
      // asked for, not something you discover in a bill.
      //
      // The `execute` slot is deliberately unbound. Binding it (e.g.
      //   execute: "local", with a 7B+ model and toolDialect "react")
      // enables plan-execute delegation: the spawn tool gains a `tier` choice
      // the think model fills per step — "light" runs the whole sub-task on
      // this binding, and a light subagent that starts going in circles stops
      // early and reports instead of grinding. A 3B model is usually below
      // the capability floor for driving a loop; that is why this is not on
      // by default.
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
    bind: { think: "cloud", observe: "cloud", verify: "cloud", title: "cloud" },
  };
}

/**
 * All-local: no network at all.
 *
 * The think model speaks **ReAct**, not native tool calling. That is not a stylistic
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
    bind: { think: "local", observe: "local", verify: "local", title: "local" },
  };
}
