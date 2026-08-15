import { Router } from "../models/router.js";
import { AnthropicPort } from "../models/providers/anthropic.js";
import { OllamaPort } from "../models/providers/ollama.js";
import { ScriptedPort } from "../models/providers/scripted.js";
import type { ChatMessage, ModelPort } from "../core/types.js";
import type { SubagentOptions } from "../steps/subagent.js";

/**
 * The configuration matrix.
 *
 * Each config isolates one mechanism so the comparison attributes cost to a
 * cause. `cloud-only` is the control; every other row's delta against it is
 * that mechanism's contribution, positive or negative.
 *
 * Note what is deliberately *not* here: a `toolformer` row. It was measured,
 * it was unconditionally negative, and it is gone (DESIGN.md §1). Re-adding a
 * row for it would suggest the question is still open.
 */

export interface BenchConfig {
  id: string;
  /** One line on what this row is for. */
  hypothesis: string;
  build(ports: BenchPorts): { router: Router; subagents: SubagentOptions | false };
}

export interface BenchPorts {
  cloud: ModelPort;
  local: ModelPort;
}

export const CONFIGS: BenchConfig[] = [
  {
    id: "cloud-only",
    hypothesis: "control — everything the frontier model does itself",
    build: ({ cloud }) => ({
      router: new Router().bind("driver", cloud),
      subagents: false,
    }),
  },
  {
    id: "cloud+subagent",
    hypothesis: "isolation alone: does keeping search out of the parent pay for the spawn floor?",
    build: ({ cloud }) => ({
      router: new Router().bind("driver", cloud).bind("verifier", cloud),
      subagents: { maxDepth: 2, maxSpawns: 4, maxSteps: 8 },
    }),
  },
  {
    id: "cloud+local-digest",
    hypothesis: "compression alone: does the digest save money without losing the answer?",
    build: ({ cloud, local }) => ({
      router: new Router().bind("driver", cloud).bind("digester", local, { fallbacks: [cloud] }),
      subagents: false,
    }),
  },
  {
    id: "hybrid",
    hypothesis: "both — the shipped default",
    build: ({ cloud, local }) => ({
      router: new Router()
        .bind("driver", cloud)
        .bind("digester", local, { fallbacks: [cloud] })
        .bind("verifier", cloud),
      subagents: { maxDepth: 2, maxSpawns: 4, maxSteps: 8 },
    }),
  },
  {
    id: "local-only",
    hypothesis: "capability floor: can this run with no network at all?",
    build: ({ local }) => ({
      router: new Router().bind("driver", local).bind("digester", local),
      subagents: false,
    }),
  },
];

// ── ports ───────────────────────────────────────────────────────────────────

export function realPorts(opts: { cloudModel: string; localModel: string; apiKey: string }): BenchPorts {
  return {
    cloud: new AnthropicPort({
      id: `cloud/${opts.cloudModel}`,
      model: opts.cloudModel,
      apiKey: opts.apiKey,
      costPerMTokIn: 3,
      costPerMTokOut: 15,
    }),
    local: new OllamaPort({ id: `local/${opts.localModel}`, model: opts.localModel }),
  };
}

/**
 * Scripted ports for the offline run.
 *
 * These measure **mechanism overhead**, not model quality: the scripted driver
 * always finds the right answer, so `success` is meaningless offline and the
 * report says so. What the offline run *does* measure exactly — and for free,
 * deterministically, in CI — is how many tokens each mechanism costs to have.
 */
export function scriptedPorts(fixtureLog: string): BenchPorts {
  return {
    cloud: new ScriptedPort({
      id: "cloud/scripted",
      locality: "cloud",
      costPerMTokIn: 3,
      costPerMTokOut: 15,
      contextWindow: 200_000,
      latencyMs: 5,
      handler: (req, turn) => scriptedDriver(req, turn, fixtureLog),
    }),
    local: new ScriptedPort({
      id: "local/scripted",
      locality: "local",
      contextWindow: 32_768,
      latencyMs: 2,
      handler: () => ({
        text:
          "npm test: 332 tests, 331 pass, 1 fail.\n" +
          "FAIL: unit/parser rejects trailing comma\n" +
          "  src/parser.ts:5 — expected SyntaxError, got undefined\n" +
          "(dropped 330 passing lines)",
      }),
    }),
  };
}

/**
 * A scripted driver that plays each task correctly.
 *
 * **Stateless on purpose.** An earlier version branched on a turn counter and
 * produced silently wrong numbers, because `ScriptedPort` counts turns
 * per-instance and the benchmark reuses one instance across configs. Keying off
 * the conversation contents instead makes the driver correct regardless of how
 * many times it has been called, by whom, in what order — which is the only
 * property a benchmark fixture actually needs.
 *
 * It uses read-only tools only, so the benchmark can run with side effects
 * disabled and cannot damage its own fixtures.
 */
function scriptedDriver(
  req: { system: string; messages: ChatMessage[] },
  _turn: number,
  _log: string,
): { text: string; toolCalls?: Array<{ id: string; name: string; args: Record<string, unknown> }> } {
  // Shared-port configs route the digester and verifier here too.
  if (req.system.includes("You compress tool output")) {
    return {
      text:
        "npm test: 332 tests, 331 pass, 1 fail.\n" +
        "FAIL: unit/parser rejects trailing comma\n" +
        "  src/parser.ts:5 — expected SyntaxError, got undefined\n" +
        "(dropped 330 passing lines)",
    };
  }
  if (req.system.includes("safety check")) {
    return { text: '{"verdict":"allow","reason":"in scope"}' };
  }

  const prompt = firstUserText(req.messages);
  const observations = toolTexts(req.messages);
  const seen = (needle: string) => observations.some((o) => o.includes(needle));

  // failing-test: read the log, then answer from it (raw or digested).
  if (prompt.includes("run.log")) {
    if (!observations.length) {
      return { text: "", toolCalls: [call("read_file", { path: "test/run.log" })] };
    }
    // Answer from whatever landed in context — which is exactly the thing
    // under test: a lossy digest would strip the location and this would fail.
    const body = observations.join("\n");
    const loc = /src\/parser\.ts:\d+/.exec(body)?.[0] ?? "an unknown location";
    const named = body.includes("trailing comma") ? "unit/parser rejects trailing comma" : "an unnamed test";
    return { text: `1 test failed: \`${named}\`, at ${loc}.` };
  }

  // find-symbol: list src/, then read until parseConfig turns up.
  if (prompt.includes("parseConfig")) {
    if (!observations.length) return { text: "", toolCalls: [call("list_dir", { path: "src" })] };
    if (seen("parseConfig")) return { text: "src/config.ts" };
    const next = ["config.ts", "parser.ts", "server.ts", "util.ts"].find(
      (f) => !seen(`// read ${f}`) && !observations.some((o) => o.includes(`src/${f}`)),
    );
    return { text: "", toolCalls: [call("read_file", { path: `src/${next ?? "config.ts"}` })] };
  }

  // list-importers: read every source file, report those importing lodash.
  if (prompt.includes("lodash")) {
    const files = ["config.ts", "parser.ts", "server.ts", "util.ts"];
    const read = observations.length;
    if (read < files.length) {
      return { text: "", toolCalls: [call("read_file", { path: `src/${files[read]}` })] };
    }
    const hits = files.filter((_f, i) => (observations[i] ?? "").includes("lodash"));
    return { text: hits.map((f) => `src/${f}`).join("\n") };
  }

  // dep-version
  if (prompt.includes("typescript")) {
    if (!observations.length) return { text: "", toolCalls: [call("read_file", { path: "package.json" })] };
    return { text: /"typescript":\s*"([^"]+)"/.exec(observations.join(""))?.[1] ?? "unknown" };
  }

  return { text: "done" };
}

let callSeq = 0;
function call(name: string, args: Record<string, unknown>) {
  return { id: `b${callSeq++}`, name, args };
}

function firstUserText(messages: ChatMessage[]): string {
  const m = messages.find((x) => x.role === "user");
  return m && m.role === "user" ? m.content : "";
}

function toolTexts(messages: ChatMessage[]): string[] {
  return messages.flatMap((m) => (m.role === "tool" ? m.results.map((r) => r.content) : []));
}
