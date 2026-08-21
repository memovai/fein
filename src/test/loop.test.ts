import { test } from "node:test";
import assert from "node:assert/strict";
import { LoopGuard, stableJson } from "../core/guards.js";
import { Agent, type FeinTrace } from "../core/loop.js";
import { Router } from "../models/router.js";
import { escalateOnStuck } from "../models/policy.js";
import { ScriptedPort } from "../models/providers/scripted.js";
import { ToolRegistry, type Tool } from "../tools/registry.js";
import type { ToolCall, ToolResult } from "../core/types.js";

const call = (name: string, args: Record<string, unknown> = {}): ToolCall => ({
  id: `c${Math.random()}`,
  name,
  args,
});
const result = (content: string): ToolResult => ({ callId: "x", content, isError: false });

// ── the guard ───────────────────────────────────────────────────────────────

test("identical call with identical result eventually nudges", () => {
  const g = new LoopGuard();
  const turn = () => g.observe({ calls: [call("read_file", { path: "a" })], results: [result("same")], hadAnswer: false });

  assert.equal(turn(), undefined, "once is normal");
  assert.equal(turn(), undefined, "twice is tolerable — retries are legitimate");
  const third = turn();
  assert.equal(third?.kind, "repeat");
  assert.match(third!.message, /cannot produce new information/);
});

test("the same call with a DIFFERENT result never nudges", () => {
  // Polling a build, re-reading an edited file, retrying a flaky command — all
  // legitimate. Only same-question-same-answer is definitionally useless.
  const g = new LoopGuard();
  for (let i = 0; i < 6; i++) {
    const s = g.observe({
      calls: [call("shell", { command: "npm test" })],
      results: [result(`attempt ${i}`)],
      hadAnswer: false,
    });
    assert.equal(s, undefined, `false positive on turn ${i}`);
  }
});

test("argument key order does not hide a repeat", () => {
  const g = new LoopGuard();
  const a = { path: "x", limit: 10 };
  const b = { limit: 10, path: "x" }; // same call, different key order
  g.observe({ calls: [{ id: "1", name: "read", args: a }], results: [result("r")], hadAnswer: false });
  g.observe({ calls: [{ id: "2", name: "read", args: b }], results: [result("r")], hadAnswer: false });
  const s = g.observe({ calls: [{ id: "3", name: "read", args: a }], results: [result("r")], hadAnswer: false });
  assert.equal(s?.kind, "repeat", "key order must not defeat the signature");
});

test("oscillation between two actions is detected", () => {
  const g = new LoopGuard({ repeatThreshold: 99 }); // isolate from the repeat rule
  const a = () => g.observe({ calls: [call("read_file", { path: "a" })], results: [result("ra")], hadAnswer: false });
  const b = () => g.observe({ calls: [call("read_file", { path: "b" })], results: [result("rb")], hadAnswer: false });

  a();
  b();
  a();
  const s = b();
  assert.equal(s?.kind, "oscillation");
  assert.match(s!.message, /alternating between the same two actions/);
});

test("stalling — neither acting nor answering — is detected", () => {
  const g = new LoopGuard();
  g.observe({ calls: [], results: [], hadAnswer: false });
  const s = g.observe({ calls: [], results: [], hadAnswer: false });
  assert.equal(s?.kind, "stalled");
});

test("each problem fires once — a guard that repeats itself is also a loop", () => {
  const g = new LoopGuard();
  const turn = () => g.observe({ calls: [call("x")], results: [result("same")], hadAnswer: false });
  turn();
  turn();
  assert.equal(turn()?.kind, "repeat");
  assert.equal(turn(), undefined, "must not warn every turn thereafter");
  assert.equal(turn(), undefined);
});

test("stableJson is order-independent and handles nesting", () => {
  assert.equal(stableJson({ b: 1, a: 2 }), stableJson({ a: 2, b: 1 }));
  assert.equal(stableJson({ a: [1, { y: 1, x: 2 }] }), stableJson({ a: [1, { x: 2, y: 1 }] }));
  assert.notEqual(stableJson({ a: 1 }), stableJson({ a: 2 }));
});

// ── the loop ────────────────────────────────────────────────────────────────

function stuckAgent(maxSteps: number, trace: FeinTrace[]): Agent {
  const reg = new ToolRegistry().register({
    spec: {
      name: "look",
      description: "look",
      parameters: { type: "object", properties: {} },
    },
    async run() {
      return "always the same answer";
    },
  } as Tool);

  // A model that never stops calling the same thing — the classic death spiral.
  const port = new ScriptedPort({
    id: "cloud",
    locality: "cloud",
    handler: (req) => {
      const convo = JSON.stringify(req.messages);
      if (convo.includes("cannot take further actions")) {
        return { text: "I kept checking the same thing and learned nothing new." };
      }
      return { text: "", toolCalls: [{ id: "t", name: "look", args: {} }] };
    },
  });

  return new Agent({
    router: new Router().bind("think", port),
    tools: reg,
    subagents: false,
    maxSteps,
    onEvent: (e) => trace.push(e),
  });
}

test("a stuck loop gets nudged rather than silently spinning", async () => {
  const trace: FeinTrace[] = [];
  await stuckAgent(6, trace).run("check the thing");

  const guards = trace.filter((e) => e.type === "guard");
  assert.ok(guards.length >= 1, "the harness must notice; the model cannot see its own loop");
  assert.equal((guards[0] as { kind: string }).kind, "repeat");
});

test("with a policy bound, a stuck loop escalates thinking on the same port", async () => {
  const trace: FeinTrace[] = [];
  const reg = new ToolRegistry().register({
    spec: { name: "look", description: "look", parameters: { type: "object", properties: {} } },
    async run() {
      return "always the same answer";
    },
  } as Tool);

  const seen: Array<string | undefined> = [];
  const port = new ScriptedPort({
    id: "cloud",
    locality: "cloud",
    handler: (req) => {
      seen.push(req.thinking);
      const convo = JSON.stringify(req.messages);
      if (convo.includes("cannot take further actions")) {
        return { text: "nothing new to learn here" };
      }
      return { text: "", toolCalls: [{ id: "t", name: "look", args: {} }] };
    },
  });

  const agent = new Agent({
    router: new Router().bind("think", port, { policy: escalateOnStuck() }),
    tools: reg,
    subagents: false,
    maxSteps: 6,
    onEvent: (e) => trace.push(e),
  });
  await agent.run("check the thing");

  // Order matters: the guard is the cause, the route is the effect.
  const guardIdx = trace.findIndex((e) => e.type === "guard");
  const routeIdx = trace.findIndex((e) => e.type === "route");
  assert.ok(guardIdx >= 0, "the guard must fire first");
  assert.ok(routeIdx > guardIdx, "escalation follows the guard");

  // Effort rises after the guard and stays raised — sticky for the run.
  assert.equal(seen[0], undefined, "the run starts at default effort");
  const firstRaised = seen.findIndex((t) => t !== undefined);
  assert.ok(firstRaised > 0, "the guard fire raises the thinking level");
  assert.equal(seen[firstRaised], "medium");
  assert.ok(
    seen.slice(firstRaised).every((t) => t !== undefined),
    "escalation does not flap back down mid-run",
  );

  // The whole point: never a port swap, and therefore never a prefix break.
  const routes = trace.filter((e) => e.type === "route") as Array<{ model: string }>;
  assert.ok(routes.length >= 1);
  assert.ok(routes.every((r) => r.model === "cloud"), "same port throughout");
  assert.equal(agent.ledger.summary().cache.breaks.length, 0, "the cached prefix survives");
  assert.ok(agent.ledger.summary().escalations >= 1, "and the ledger can prove it happened");
});

test("a spent ladder restarts the epoch on the stronger port — and only at the boundary", async () => {
  const trace: FeinTrace[] = [];
  const reg = new ToolRegistry().register({
    spec: { name: "look", description: "look", parameters: { type: "object", properties: {} } },
    async run() {
      return "same answer";
    },
  } as Tool);

  // The weak model burns through two distinct repeat problems (the guard keys
  // repeats by call signature, so each fires once): turns 0-2 repeat q=a,
  // turns 3-5 repeat q=b — two fires against a one-rung ladder. Turn 6 is the
  // turn that *carries* the restart request; the epoch lands before turn 7.
  let weakCalls = 0;
  const weak = new ScriptedPort({
    id: "weak",
    locality: "cloud",
    handler: (_req, turn) => {
      weakCalls++;
      const q = turn < 3 ? "a" : turn < 6 ? "b" : "c";
      return { text: "", toolCalls: [{ id: `t${turn}`, name: "look", args: { q } }] };
    },
  });
  let strongCalls = 0;
  const strong = new ScriptedPort({
    id: "strong",
    locality: "cloud",
    handler: (req) => {
      strongCalls++;
      const convo = JSON.stringify(req.messages);
      assert.ok(convo.includes("SUMMARY"), "the strong port starts from the epoch summary");
      return { text: "solved: the needle was in the config" };
    },
  });
  const summarizer = new ScriptedPort({
    id: "local",
    locality: "local",
    handler: () => ({ text: "SUMMARY: still hunting the needle; look() exhausted." }),
  });

  const agent = new Agent({
    router: new Router()
      .bind("think", weak, {
        fallbacks: [strong],
        policy: escalateOnStuck({ ladder: ["high"], restartTo: strong }),
      })
      .bind("observe", summarizer),
    tools: reg,
    subagents: false,
    maxSteps: 12,
    onEvent: (e) => trace.push(e),
  });
  const run = await agent.run("find the needle");

  // The restart happened, at the boundary, for the stated reason.
  const epoch = trace.find((e) => e.type === "epoch") as { reason: string } | undefined;
  assert.ok(epoch, "the epoch must fire");
  assert.match(epoch.reason, /routing policy requested a restart/);

  // The strong port took over after the epoch and finished the task.
  assert.ok(strongCalls >= 1, "the stronger port serves the new epoch");
  assert.match(run.text, /solved: the needle was in the config/);
  assert.equal(run.stoppedBecause, "final_answer");

  // Both ports appear in the ledger under the think slot; the route trace
  // names the restart.
  const thinkModels = new Set(agent.ledger.all.filter((r) => r.slot === "think").map((r) => r.model.id));
  assert.ok(thinkModels.has("weak") && thinkModels.has("strong"));
  const routes = trace.filter((e) => e.type === "route") as Array<{ reason: string }>;
  assert.ok(routes.some((r) => /restarted on strong/.test(r.reason)));

  // And the weak port was never called again after the epoch.
  const epochIdx = trace.findIndex((e) => e.type === "epoch");
  const stepsAfter = trace
    .slice(epochIdx)
    .filter((e) => e.type === "step") as Array<{ model: string }>;
  assert.ok(stepsAfter.every((s) => s.model === "strong"), "no mid-epoch flip-flop");
  assert.ok(weakCalls >= 6, "the weak port did the pre-restart work");
});

test("running out of turns forces a real answer, not a leftover fragment", async () => {
  const trace: FeinTrace[] = [];
  const run = await stuckAgent(3, trace).run("check the thing");

  assert.equal(run.stoppedBecause, "max_steps");
  assert.match(
    run.text,
    /learned nothing new/,
    "the wrap-up answer, not whatever text happened to be last",
  );
});

test("the wrap-up call withholds tools so it cannot start another cycle", async () => {
  let sawToolsOnFinal: unknown = "unset";
  const reg = new ToolRegistry().register({
    spec: { name: "look", description: "look", parameters: { type: "object", properties: {} } },
    async run() {
      return "same";
    },
  } as Tool);

  const port = new ScriptedPort({
    id: "cloud",
    locality: "cloud",
    handler: (req) => {
      const convo = JSON.stringify(req.messages);
      if (convo.includes("cannot take further actions")) {
        sawToolsOnFinal = req.tools;
        return { text: "done with what I have" };
      }
      return { text: "", toolCalls: [{ id: "t", name: "look", args: {} }] };
    },
  });

  await new Agent({
    router: new Router().bind("think", port),
    tools: reg,
    subagents: false,
    maxSteps: 2,
  }).run("go");

  assert.equal(sawToolsOnFinal, undefined, "removing the capability is a guarantee; asking is not");
});

test("turn lifecycle events bracket each cycle", async () => {
  const trace: FeinTrace[] = [];
  const reg = new ToolRegistry().register({
    spec: { name: "peek", description: "peek", parameters: { type: "object", properties: {} } },
    async run() {
      return "ok";
    },
  } as Tool);

  const port = new ScriptedPort({
    id: "cloud",
    locality: "cloud",
    handler: (_r, turn) =>
      turn === 0
        ? { text: "", toolCalls: [{ id: "t", name: "peek", args: {} }] }
        : { text: "all done" },
  });

  await new Agent({
    router: new Router().bind("think", port),
    tools: reg,
    subagents: false,
    maxSteps: 4,
    onEvent: (e) => trace.push(e),
  }).run("go");

  const kinds = trace.map((e) => e.type);
  assert.equal(kinds.filter((k) => k === "agent_start").length, 1);
  assert.equal(kinds.filter((k) => k === "agent_end").length, 1);
  assert.equal(kinds.filter((k) => k === "turn_start").length, 2);
  assert.equal(kinds.filter((k) => k === "turn_end").length, 2);

  // A turn that acted and a turn that answered are distinguishable.
  const ends = trace.filter((e) => e.type === "turn_end") as Array<{ acted: boolean }>;
  assert.deepEqual(ends.map((e) => e.acted), [true, false]);
});

test("a healthy loop is never nudged", async () => {
  const trace: FeinTrace[] = [];
  const reg = new ToolRegistry().register({
    spec: {
      name: "step",
      description: "step",
      parameters: { type: "object", properties: { n: { type: "string" } } },
    },
    async run(args) {
      return `result ${String(args["n"])}`;
    },
  } as Tool);

  const port = new ScriptedPort({
    id: "cloud",
    locality: "cloud",
    handler: (_r, turn) =>
      turn < 3
        ? { text: "", toolCalls: [{ id: `t${turn}`, name: "step", args: { n: String(turn) } }] }
        : { text: "finished" },
  });

  await new Agent({
    router: new Router().bind("think", port),
    tools: reg,
    subagents: false,
    maxSteps: 6,
    onEvent: (e) => trace.push(e),
  }).run("go");

  assert.equal(trace.filter((e) => e.type === "guard").length, 0, "no false positives");
});

test("the nudge is an appended system note — cache-safe and unspoofable", async () => {
  const trace: FeinTrace[] = [];
  const agent = stuckAgent(6, trace);
  await agent.run("check");

  const view = agent.view();
  const note = view.find(
    (m) => m.role === "system" && /cannot produce new information/.test(m.content),
  );
  assert.ok(note, "the guidance must reach the model, not just the terminal");

  // No prefix breaks: appending a note must not rewrite anything.
  assert.equal(agent.ledger.summary().cache.breaks.length, 0);
});
