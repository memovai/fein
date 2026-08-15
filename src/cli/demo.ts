import { ScriptedPort } from "../models/providers/scripted.js";
import { Router } from "../models/router.js";
import { Agent, type FeinTrace } from "../core/loop.js";
import { ToolRegistry } from "../tools/registry.js";
import type { Tool } from "../tools/registry.js";

/**
 * An offline, deterministic walkthrough of the hybrid loop.
 *
 * No keys, no GPU, no network. Every model is scripted, so what you are
 * watching is the *harness*, which is the part that is actually novel. The
 * scripted cloud driver reports realistic token counts and the scripted local
 * models behave the way small models actually behave — including getting an
 * argument wrong once, so you can see the retry-and-validate path work.
 */

const BIG_LOG = [
  "$ npm test",
  ...Array.from({ length: 240 }, (_, i) => `  ok ${i + 1} - unit/parser handles case ${i + 1}`),
  "  not ok 241 - unit/parser rejects trailing comma",
  "    at src/parser.ts:118  expected SyntaxError, got undefined",
  ...Array.from({ length: 90 }, (_, i) => `  ok ${242 + i} - unit/emitter case ${i + 1}`),
  "# pass 331  # fail 1",
].join("\n");

const fakeTools = new ToolRegistry();
const listTool: Tool = {
  spec: {
    name: "list_dir",
    description: "List entries in a workspace directory.",
    parameters: { type: "object", properties: { path: { type: "string" } } },
  },
  async run() {
    return ["src/", "test/", "package.json", "tsconfig.json", "README.md"].join("\n");
  },
};
const testTool: Tool = {
  spec: {
    name: "shell",
    description: "Run a shell command in the workspace.",
    parameters: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
    },
    sideEffects: true,
  },
  async run() {
    return BIG_LOG;
  },
};
fakeTools.register(listTool).register(testTool);

export function buildDemoAgent(onEvent: (e: FeinTrace) => void): Agent {
  // --- The cloud driver: expensive, decides what happens. -------------------
  const cloud = new ScriptedPort({
    id: "cloud/sonnet-sim",
    locality: "cloud",
    costPerMTokIn: 3,
    costPerMTokOut: 15,
    contextWindow: 200_000,
    latencyMs: 40,
    handler: (_req, turn) => {
      switch (turn) {
        case 0:
          return {
            text: "Let me see what is in the workspace.",
            toolCalls: [{ id: "c1", name: "list_dir", args: { path: "." } }],
          };
        case 1:
          return {
            text: "A TypeScript project. Running the test suite to find the failure.",
            toolCalls: [{ id: "c2", name: "shell", args: { command: "npm test" } }],
          };
        default:
          return {
            text:
              "One test fails: `unit/parser rejects trailing comma` at src/parser.ts:118 — it " +
              "expected a SyntaxError but got undefined. 331 of 332 tests pass. The parser is " +
              "silently accepting trailing commas instead of raising.",
          };
      }
    },
  });

  // --- The local digester: compresses the 330-line test log. ---------------
  //
  // This is the whole hybrid story in one step. The driver decided to run
  // `npm test` itself — its authority is untouched — but the 3100-token log
  // is compressed on this machine before the driver ever sees it. Two things
  // follow that a cheap *cloud* subagent could not give you: the saving
  // compounds over every remaining turn, and the raw log never leaves the
  // laptop.
  const localDigester = new ScriptedPort({
    id: "local/qwen3b-sim",
    locality: "local",
    contextWindow: 32_768,
    latencyMs: 30,
    handler: () => ({
      text: [
        "npm test: 332 tests, 331 pass, 1 fail.",
        "FAIL: unit/parser rejects trailing comma",
        "  src/parser.ts:118 — expected SyntaxError, got undefined",
        "(dropped 330 passing test lines)",
      ].join("\n"),
    }),
  });

  const router = new Router()
    .bind("driver", cloud)
    .bind("digester", localDigester, { fallbacks: [cloud] });

  return new Agent({
    router,
    tools: fakeTools,
    cwd: "/demo/workspace",
    maxSteps: 8,
    subagents: false,
    onEvent,
  });
}
