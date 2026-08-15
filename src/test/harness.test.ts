import { test } from "node:test";
import assert from "node:assert/strict";
import { Transcript } from "../core/transcript.js";
import { MainLens, PrefixGuard } from "../context/lens.js";
import { Router } from "../models/router.js";
import { Ledger } from "../telemetry/ledger.js";
import { ScriptedPort } from "../models/providers/scripted.js";
import { ToolRegistry, validateArgs, type Tool } from "../tools/registry.js";
import { parseJsonToolCalls } from "../models/providers/openai.js";
import { Agent } from "../core/loop.js";

function echoTool(name = "echo", sideEffects = false): Tool {
  return {
    spec: {
      name,
      description: "Echo a value back.",
      parameters: {
        type: "object",
        properties: { value: { type: "string" } },
        required: ["value"],
      },
      ...(sideEffects ? { sideEffects: true } : {}),
    },
    async run(args) {
      return String(args["value"]);
    },
  };
}

// --- prefix stability -------------------------------------------------------

test("lens renders are monotonic as the transcript grows", () => {
  const t = new Transcript();
  const lens = new MainLens(false);
  const guard = new PrefixGuard();

  t.user("hello");
  assert.equal(guard.check(lens.render(t)).stable, true);

  t.assistant("hi", [{ id: "a", name: "echo", args: { value: "x" } }], "driver@test");
  t.toolResult({ callId: "a", content: "x", isError: false });
  const second = guard.check(lens.render(t));
  assert.equal(second.stable, true);
  assert.equal(second.reusedMessages, 1);
  assert.equal(second.newMessages, 2);
});

test("PrefixGuard reports a break when history is rewritten", () => {
  const guard = new PrefixGuard();
  guard.check([
    { role: "user", content: "a" },
    { role: "user", content: "b" },
  ]);
  const report = guard.check([
    { role: "user", content: "a" },
    { role: "user", content: "CHANGED" },
  ]);
  assert.equal(report.stable, false);
  assert.equal(report.brokenAt, 1);
});

test("a digest arriving after first render does not rewrite history", () => {
  const t = new Transcript();
  const lens = new MainLens(true);
  const guard = new PrefixGuard();

  t.user("go");
  t.assistant("", [{ id: "a", name: "echo", args: { value: "x" } }], "driver@test");
  const ev = t.toolResult({ callId: "a", content: "a very long output".repeat(50), isError: false });

  guard.check(lens.render(t)); // driver has now seen the raw output

  // Late digest: must be ignored by this lens, because substituting now would
  // rewrite a prefix the model already consumed.
  t.digest(ev.id, "short summary", "digester@test");
  const report = guard.check(lens.render(t));
  assert.equal(report.stable, true, "late digest must not break the prefix");
});

test("a digest arriving before first render is substituted", () => {
  const t = new Transcript();
  const lens = new MainLens(true);

  t.user("go");
  t.assistant("", [{ id: "a", name: "echo", args: { value: "x" } }], "driver@test");
  const ev = t.toolResult({ callId: "a", content: "RAW-BULK", isError: false });
  t.digest(ev.id, "SHORT", "digester@test");

  const rendered = lens.render(t);
  const toolMsg = rendered.find((m) => m.role === "tool");
  assert.ok(toolMsg && toolMsg.role === "tool");
  assert.match(toolMsg.results[0]!.content, /SHORT/);
  assert.doesNotMatch(toolMsg.results[0]!.content, /RAW-BULK/);
});

test("epoch restarts the rendered view from the snapshot", () => {
  const t = new Transcript();
  const lens = new MainLens(false);
  t.user("old thing");
  t.assistant("old reply", [], "driver@test");
  t.epoch("window full", "SUMMARY OF EVERYTHING");
  t.user("new thing");

  const rendered = lens.render(t);
  assert.equal(rendered.length, 2);
  assert.match((rendered[0] as { content: string }).content, /SUMMARY OF EVERYTHING/);
  assert.equal((rendered[1] as { content: string }).content, "new thing");
});

// --- tool argument validation ----------------------------------------------

test("validateArgs catches the mistakes small models actually make", () => {
  const spec = echoTool().spec;
  assert.match(validateArgs(spec, {})!, /missing required "value"/);
  assert.match(validateArgs(spec, { valu: "x" })!, /unknown property "valu"/);
  assert.match(validateArgs(spec, { value: 3 })!, /should be string/);
  assert.equal(validateArgs(spec, { value: "ok" }), undefined);
});

test("parseJsonToolCalls handles the shapes local models emit", () => {
  const shapes = [
    '{"name":"echo","arguments":{"value":"a"}}',
    'Sure!\n```json\n{"name":"echo","arguments":{"value":"a"}}\n```',
    '{"tool":"echo","args":{"value":"a"}}',
    'thinking... {"name":"echo","parameters":{"value":"a"}} done',
  ];
  for (const s of shapes) {
    const calls = parseJsonToolCalls(s);
    assert.equal(calls[0]?.name, "echo", `failed on: ${s}`);
    assert.equal(calls[0]?.args["value"], "a");
  }
});

// --- routing ----------------------------------------------------------------

test("router falls back to the next port when the primary throws", async () => {
  const dead = new ScriptedPort({
    id: "dead",
    locality: "local",
    handler: () => {
      throw new Error("connection refused");
    },
  });
  const alive = new ScriptedPort({ id: "alive", locality: "cloud", handler: () => ({ text: "ok" }) });
  const router = new Router().bind("digester", dead, { fallbacks: [alive] });

  const outcome = await router.run("digester", { system: "s", messages: [] });
  assert.equal(outcome.result.text, "ok");
  assert.equal(outcome.port.info.id, "alive");
  assert.equal(outcome.attempts.length, 1);
  assert.match(outcome.attempts[0]!.error, /connection refused/);
});

test("unbound slot fails with an actionable message", () => {
  assert.throws(() => new Router().portFor("digester"), /no model bound to slot "digester"/);
});



// --- registry freezing ------------------------------------------------------

test("registering a tool after freeze is refused", () => {
  const reg = new ToolRegistry().register(echoTool()).freeze();
  assert.throws(() => reg.register(echoTool("other")), /invalidate the prompt cache/);
});

// --- end to end -------------------------------------------------------------

test("hybrid loop: driver keeps the decision, local digester compresses the result", async () => {
  const bulk = Array.from({ length: 2000 }, (_, i) => `line ${i} of routine output`).join("\n");
  const reg = new ToolRegistry().register({
    spec: {
      name: "dump",
      description: "Dump a lot of text.",
      parameters: { type: "object", properties: { n: { type: "string" } }, required: ["n"] },
    },
    async run() {
      return bulk;
    },
  });

  const cloud = new ScriptedPort({
    id: "cloud",
    locality: "cloud",
    costPerMTokIn: 3,
    costPerMTokOut: 15,
    handler: (_r, turn) =>
      turn === 0
        ? { text: "", toolCalls: [{ id: "d1", name: "dump", args: { n: "1" } }] }
        : { text: "done" },
  });
  const local = new ScriptedPort({
    id: "local",
    locality: "local",
    handler: () => ({ text: "2000 similar lines of routine output; nothing anomalous." }),
  });

  const agent = new Agent({
    router: new Router().bind("driver", cloud).bind("digester", local),
    tools: reg,
    subagents: false,
    maxSteps: 4,
  });

  const traces: string[] = [];
  const run = await agent.run("dump it");
  void traces;

  assert.equal(run.stoppedBecause, "final_answer");
  assert.equal(run.text, "done");

  // The driver must have seen the digest, not the 2000-line dump.
  const view = agent.view();
  const toolMsg = view.find((m) => m.role === "tool");
  assert.ok(toolMsg && toolMsg.role === "tool");
  assert.match(toolMsg.results[0]!.content, /2000 similar lines/);
  assert.doesNotMatch(toolMsg.results[0]!.content, /line 1500 of routine output/);

  // And the ledger must attribute the digest work to the local model.
  const summary = agent.ledger.summary({ in: 3, out: 15 });
  assert.ok(summary.bySlot["digester"]!.local >= 1, "the digest must be served locally");
  assert.equal(summary.cache.breaks.length, 0, "no prefix breaks in a clean hybrid run");
});

test("a subagent's mutations are verified; the driver's are not", async () => {
  const reg = new ToolRegistry().register(echoTool("mutate", true));
  const calls: string[] = [];

  // A fresh port per agent: ScriptedPort's turn counter is per-instance, so a
  // shared one would leave the second agent already past its first turn.
  const makeCloud = () =>
    new ScriptedPort({
      id: "cloud",
      locality: "cloud",
      handler: (req, turn) => {
        const text = req.messages.map((m) => ("content" in m ? m.content : "")).join(" ");
        if (text.includes("Tool it wants to call")) {
          calls.push("verifier");
          return { text: '{"verdict":"deny","reason":"not what the task asked for"}' };
        }
        return turn === 0
          ? { text: "", toolCalls: [{ id: "m1", name: "mutate", args: { value: "hi" } }] }
          : { text: "stopped" };
      },
    });

  // depth 0 — the driver is the authority, so no verifier round trip.
  const cloud = makeCloud();
  const top = new Agent({
    router: new Router().bind("driver", cloud).bind("verifier", cloud),
    tools: reg,
    subagents: false,
    maxSteps: 3,
  });
  await top.run("mutate please");
  assert.equal(calls.length, 0, "the driver's own mutations are not second-guessed");

  // depth 1 — acting on a task another model wrote, so it is checked.
  const reg2 = new ToolRegistry().register(echoTool("mutate", true));
  const cloud2 = makeCloud();
  const sub = new Agent({
    router: new Router().bind("driver", cloud2).bind("verifier", cloud2),
    tools: reg2,
    depth: 1,
    subagents: false,
    maxSteps: 3,
  });
  await sub.run("mutate please");
  assert.equal(calls.length, 1, "a subagent's mutation goes past the verifier");

  const blocked = sub.view().find((m) => m.role === "tool");
  assert.ok(blocked && blocked.role === "tool");
  assert.match(blocked.results[0]!.content, /Blocked by the verifier/);
});

test("the digest actually reaches the driver (regression: compaction froze it first)", async () => {
  // The benchmark caught this: `maybeCompact` rendered through the *real* lens
  // to estimate context size, which froze every event. The subsequent real
  // render then saw frozen events and fell back to raw — so the digester ran,
  // billed, and its output was thrown away. Symptom: identical cloud token
  // counts with and without a digester bound.
  const bulk = "a routine line of output\n".repeat(400);
  const reg = new ToolRegistry().register({
    spec: { name: "dump", description: "dump", parameters: { type: "object", properties: {} } },
    async run() {
      return bulk;
    },
  });
  const cloud = new ScriptedPort({
    id: "cloud",
    locality: "cloud",
    handler: (_r, turn) =>
      turn === 0
        ? { text: "", toolCalls: [{ id: "d", name: "dump", args: {} }] }
        : { text: "done" },
  });
  const local = new ScriptedPort({
    id: "local",
    locality: "local",
    handler: () => ({ text: "400 routine lines; nothing anomalous." }),
  });

  const agent = new Agent({
    router: new Router().bind("driver", cloud).bind("digester", local),
    tools: reg,
    subagents: false,
    maxSteps: 3,
  });
  await agent.run("dump it");

  const toolMsg = agent.view().find((m) => m.role === "tool");
  assert.ok(toolMsg && toolMsg.role === "tool");
  assert.match(toolMsg.results[0]!.content, /400 routine lines/, "driver must see the digest");
  assert.doesNotMatch(toolMsg.results[0]!.content, /a routine line of output/, "not the raw bulk");

  // The economic assertion, which is the one that actually regressed: the
  // driver's prompt must be far smaller than the raw output it replaced.
  const cloudIn = agent.ledger.summary().byLocality.cloud.inTok;
  assert.ok(cloudIn < 1000, `driver read ${cloudIn} tokens — the digest did not take effect`);
});

test("ledger reports cache hit rate and offload estimate", () => {
  const ledger = new Ledger();
  const cloudInfo = {
    id: "cloud",
    provider: "x",
    model: "m",
    locality: "cloud" as const,
    toolDialect: "native" as const,
    costPerMTokIn: 3,
    costPerMTokOut: 15,
    contextWindow: 200_000,
  };
  ledger.record("driver", cloudInfo, {
    text: "",
    toolCalls: [],
    latencyMs: 10,
    usage: { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 9000, cacheWriteTokens: 0 },
  });
  const s = ledger.summary({ in: 3, out: 15 });
  assert.equal(s.cache.hitRate, 0.9);
  assert.ok(s.cache.savedUsd > 0);
});
