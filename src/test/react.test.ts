import { test } from "node:test";
import assert from "node:assert/strict";
import { parseReact, reactProtocol, REACT_STOP } from "../steps/react.js";
import { ReactPort, toReactTranscript } from "../models/react-port.js";
import { ScriptedPort } from "../models/providers/scripted.js";
import { Router } from "../models/router.js";
import { ToolRegistry, type Tool } from "../tools/registry.js";
import { Agent } from "../core/loop.js";
import type { ChatMessage, ToolSpec } from "../core/types.js";

const TOOLS: ToolSpec[] = [
  {
    name: "read_file",
    description: "Read a file.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
  {
    name: "list_dir",
    description: "List a directory.",
    parameters: { type: "object", properties: { path: { type: "string" } } },
  },
];

// ── parsing ─────────────────────────────────────────────────────────────────

test("parses the canonical Thought/Action/Action Input shape", () => {
  const step = parseReact(
    'Thought: I need the manifest.\nAction: read_file\nAction Input: {"path": "package.json"}',
    TOOLS,
  );
  assert.equal(step.reasoning[0]?.text, "I need the manifest.");
  assert.equal(step.toolCalls[0]?.name, "read_file");
  assert.equal(step.toolCalls[0]?.args["path"], "package.json");
  assert.equal(step.finalAnswer, undefined);
});

test("accepts the shapes small models actually produce", () => {
  const shapes = [
    'Thought: t\nAction: read_file({"path": "a.ts"})', // inline call
    'Thought: t\nAction: read_file\nAction Input: ```json\n{"path": "a.ts"}\n```', // fenced
    'Thought: t\naction: read_file\naction input: {"path": "a.ts"}', // lowercase
    'Thought: t\nAction : read_file\nAction_Input : {"path": "a.ts"}', // spacing/underscore
    'Some preamble.\nThought: t\nAction: read_file\nAction Input: {"path":"a.ts"}\n', // prose around
  ];
  for (const s of shapes) {
    const step = parseReact(s, TOOLS);
    assert.equal(step.toolCalls[0]?.name, "read_file", `failed on: ${s}`);
    assert.equal(step.toolCalls[0]?.args["path"], "a.ts", `bad args for: ${s}`);
  }
});

test("multi-line reasoning survives", () => {
  const step = parseReact(
    "Thought: first I consider this.\nThen I consider that.\nAction: list_dir\nAction Input: {}",
    TOOLS,
  );
  assert.match(step.reasoning[0]!.text, /first I consider this/);
  assert.match(step.reasoning[0]!.text, /Then I consider that/);
  assert.doesNotMatch(step.reasoning[0]!.text, /Action/);
});

test("a Final Answer terminates and wins over a stray Action", () => {
  const plain = parseReact("Thought: done.\nFinal Answer: it is 42.", TOOLS);
  assert.equal(plain.finalAnswer, "it is 42.");
  assert.equal(plain.toolCalls.length, 0);

  // A model emitting both is confused; stopping is the safe reading.
  const both = parseReact(
    'Thought: t\nAction: read_file\nAction Input: {"path":"a"}\nFinal Answer: actually 42.',
    TOOLS,
  );
  assert.equal(both.finalAnswer, "actually 42.");
  assert.equal(both.toolCalls.length, 0, "must not act and answer in one turn");
});

test("a hallucinated Observation is cut off", () => {
  // The stop sequence normally prevents this, but a provider may not honour it.
  const step = parseReact(
    'Thought: t\nAction: read_file\nAction Input: {"path":"a"}\n' +
      "Observation: the file says foo\nThought: so the answer is foo\nFinal Answer: foo",
    TOOLS,
  );
  assert.equal(step.toolCalls[0]?.name, "read_file");
  assert.equal(step.finalAnswer, undefined, "invented observations must never reach the loop");
});

test("an unknown tool is a correction, never an invented call", () => {
  const step = parseReact("Thought: t\nAction: delete_everything\nAction Input: {}", TOOLS);
  assert.equal(step.toolCalls.length, 0);
  assert.match(step.malformed!, /unknown tool "delete_everything"/);
  assert.match(step.malformed!, /read_file/, "the correction lists what is available");
});

test("unparseable Action Input is a correction, not empty arguments", () => {
  const step = parseReact("Thought: t\nAction: read_file\nAction Input: path=a.ts", TOOLS);
  assert.equal(step.toolCalls.length, 0, "guessing {} would run read_file with no path");
  assert.match(step.malformed!, /not valid JSON/);
});

test("bare prose is read as an answer, not an error", () => {
  const step = parseReact("The config lives in src/config.ts.", TOOLS);
  assert.equal(step.finalAnswer, "The config lives in src/config.ts.");
  assert.equal(step.malformed, undefined);
});

test("empty output is malformed", () => {
  assert.match(parseReact("   \n  ", TOOLS).malformed!, /no Action and no answer/);
});

test("the protocol lists every tool with its parameters", () => {
  const p = reactProtocol(TOOLS);
  assert.match(p, /read_file\(path: string\)/);
  assert.match(p, /list_dir\(path\?: string\)/, "optional parameters are marked");
  assert.match(p, /Never write an Observation yourself/);
  assert.ok(REACT_STOP.some((s) => s.includes("Observation")));
});

// ── history rewriting ───────────────────────────────────────────────────────

test("structured history is rewritten into the transcript the model speaks", () => {
  const history: ChatMessage[] = [
    { role: "user", content: "what is in src?" },
    {
      role: "assistant",
      content: "",
      reasoning: [{ kind: "text", text: "I should look." }],
      toolCalls: [{ id: "t1", name: "list_dir", args: { path: "src" } }],
    },
    { role: "tool", results: [{ callId: "t1", content: "a.ts\nb.ts", isError: false }] },
  ];

  const out = toReactTranscript(history);
  const assistant = out.find((m) => m.role === "assistant");
  assert.ok(assistant && assistant.role === "assistant");
  assert.match(assistant.content, /Thought: I should look\./);
  assert.match(assistant.content, /Action: list_dir/);
  assert.match(assistant.content, /Action Input: \{"path":"src"\}/);

  // The result comes back as an Observation — the exact token the model was
  // told to expect and the one generation stops before.
  const observation = out[out.length - 1]!;
  assert.equal(observation.role, "user");
  assert.match((observation as { content: string }).content, /Observation: a\.ts/);
});

test("an assistant turn with no tool call becomes a Final Answer", () => {
  const out = toReactTranscript([{ role: "assistant", content: "all done" }]);
  assert.match((out[0] as { content: string }).content, /Final Answer: all done/);
});

test("adjacent user turns are merged — providers reject two in a row", () => {
  const out = toReactTranscript([
    { role: "tool", results: [{ callId: "a", content: "obs", isError: false }] },
    { role: "user", content: "and now this" },
  ]);
  assert.equal(out.length, 1);
  assert.match((out[0] as { content: string }).content, /Observation: obs/);
  assert.match((out[0] as { content: string }).content, /and now this/);
});

// ── the port ────────────────────────────────────────────────────────────────

test("ReactPort presents a native interface to the loop", async () => {
  const inner = new ScriptedPort({
    id: "local",
    locality: "local",
    toolDialect: "react",
    handler: () => ({ text: 'Thought: look.\nAction: read_file\nAction Input: {"path":"a.ts"}' }),
  });
  const port = new ReactPort(inner);

  assert.equal(port.info.toolDialect, "native", "upstream must not need to know");

  const out = await port.complete({ system: "s", messages: [{ role: "user", content: "go" }], tools: TOOLS });
  assert.equal(out.toolCalls[0]?.name, "read_file");
  assert.equal(out.reasoning?.[0]?.text, "look.");
});

test("ReactPort moves tools into the prompt and stops before Observation", async () => {
  let seen: { system: string; stop?: string[]; tools?: unknown } = { system: "" };
  const inner = new ScriptedPort({
    id: "local",
    locality: "local",
    handler: (req) => {
      seen = { system: req.system, ...(req.stop ? { stop: req.stop } : {}), tools: req.tools };
      return { text: "Final Answer: ok" };
    },
  });

  await new ReactPort(inner).complete({
    system: "base",
    messages: [{ role: "user", content: "go" }],
    tools: TOOLS,
  });

  assert.match(seen.system, /^base/);
  assert.match(seen.system, /Action Input/, "the protocol is in the system prompt");
  assert.match(seen.system, /read_file\(path: string\)/, "so are the tools");
  assert.equal(seen.tools, undefined, "passing tools again would produce two dialects at once");
  assert.ok(seen.stop?.some((s) => s.includes("Observation")));
});

test("ReactPort repairs malformed output locally and bills every attempt", async () => {
  let n = 0;
  const inner = new ScriptedPort({
    id: "local",
    locality: "local",
    handler: () =>
      ++n === 1
        ? { text: "Action: read_file\nAction Input: path=a.ts" } // bad JSON
        : { text: 'Thought: retry.\nAction: read_file\nAction Input: {"path":"a.ts"}' },
  });

  const out = await new ReactPort(inner).complete({
    system: "s",
    messages: [{ role: "user", content: "go" }],
    tools: TOOLS,
  });

  assert.equal(n, 2, "it repaired in place");
  assert.equal(out.toolCalls[0]?.args["path"], "a.ts");
  // Both attempts are billed: under-reporting the model that needed the most
  // tries would flatter exactly the wrong configuration.
  assert.ok(out.usage.outputTokens > 0);
});

test("ReactPort gives up gracefully rather than throwing", async () => {
  const inner = new ScriptedPort({
    id: "local",
    locality: "local",
    handler: () => ({ text: "Action: nonexistent_tool\nAction Input: {}" }),
  });
  const out = await new ReactPort(inner, { maxRepairs: 1 }).complete({
    system: "s",
    messages: [{ role: "user", content: "go" }],
    tools: TOOLS,
  });
  assert.equal(out.toolCalls.length, 0);
  assert.ok(out.text.length > 0, "a confused reply beats an exception");
});

// ── end to end ──────────────────────────────────────────────────────────────

test("a ReAct model drives the real loop, with tools and observations", async () => {
  const reg = new ToolRegistry().register({
    spec: {
      name: "read_file",
      description: "Read a file.",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    },
    async run(args) {
      return `contents of ${String(args["path"])}`;
    },
  } as Tool);

  // A model that only ever speaks text — no native tool calling anywhere.
  const local = new ReactPort(
    new ScriptedPort({
      id: "local/qwen",
      locality: "local",
      handler: (req) => {
        const convo = JSON.stringify(req.messages);
        return convo.includes("Observation:")
          ? { text: "Thought: I have it.\nFinal Answer: the file says hello." }
          : { text: 'Thought: read it.\nAction: read_file\nAction Input: {"path":"a.ts"}' };
      },
    }),
  );

  const agent = new Agent({
    router: new Router().bind("driver", local),
    tools: reg,
    subagents: false,
    maxSteps: 5,
  });
  const run = await agent.run("what does a.ts say?");

  assert.equal(run.stoppedBecause, "final_answer");
  assert.match(run.text, /the file says hello/);

  // The loop's own view is fully structured — it never saw ReAct text.
  const view = agent.view();
  const assistant = view.find((m) => m.role === "assistant");
  assert.ok(assistant && assistant.role === "assistant");
  assert.equal(assistant.toolCalls?.[0]?.name, "read_file");
  assert.equal(assistant.reasoning?.[0]?.text, "read it.");

  const tool = view.find((m) => m.role === "tool");
  assert.ok(tool && tool.role === "tool");
  assert.match(tool.results[0]!.content, /contents of a\.ts/);
});
