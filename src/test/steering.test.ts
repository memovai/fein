import { test } from "node:test";
import assert from "node:assert/strict";
import { SteeringQueue, formatSteers } from "../core/steering.js";
import { Agent, type FeinTrace } from "../core/loop.js";
import { Router } from "../models/router.js";
import { ScriptedPort } from "../models/providers/scripted.js";
import { ToolRegistry, type Tool } from "../tools/registry.js";

// ── the queue ───────────────────────────────────────────────────────────────

test("drain takes everything at once, not one per turn", () => {
  // Three corrections typed in a row mean all three. Delivering them across
  // three turns would let the agent act on the first before seeing that the
  // second retracted it.
  const q = new SteeringQueue();
  q.push("actually check src/");
  q.push("no wait, check test/");
  q.push("and ignore the vendor dir");
  assert.equal(q.depth, 3);

  const drained = q.drain();
  assert.equal(drained.length, 3);
  assert.equal(q.depth, 0, "drain empties the queue");
  assert.deepEqual(drained.map((s) => s.text), [
    "actually check src/",
    "no wait, check test/",
    "and ignore the vendor dir",
  ]);
});

test("empty and whitespace steers are ignored", () => {
  const q = new SteeringQueue();
  q.push("");
  q.push("   \n  ");
  assert.equal(q.depth, 0);
});

test("a closed queue accepts nothing but still drains what it holds", () => {
  const q = new SteeringQueue();
  q.push("keep me");
  q.close();
  q.push("drop me");
  assert.deepEqual(q.drain().map((s) => s.text), ["keep me"]);
});

test("formatting tells the model WHEN the message arrived", () => {
  // Without the framing, a mid-task instruction reads as part of the original
  // request and the model tries to reconcile it with finished work.
  const one = formatSteers([{ text: "look in src/", queuedAt: 0 }]);
  assert.match(one, /while you were working/);
  assert.match(one, /correction to your current approach/);
  assert.match(one, /look in src\//);

  const many = formatSteers([
    { text: "check src/", queuedAt: 0 },
    { text: "actually check test/", queuedAt: 1 },
  ]);
  assert.match(many, /a later one may retract an earlier one/);
  assert.match(many, /1\. check src\//);
  assert.match(many, /2\. actually check test\//);
});

// ── the loop ────────────────────────────────────────────────────────────────

function agentThatLoops(trace: FeinTrace[], onTurn?: (agent: Agent, turn: number) => void): Agent {
  const reg = new ToolRegistry().register({
    spec: {
      name: "look",
      description: "look at something",
      parameters: { type: "object", properties: { where: { type: "string" } } },
    },
    async run(args) {
      return `contents of ${String(args["where"] ?? "?")}`;
    },
  } as Tool);

  let turn = 0;
  const port = new ScriptedPort({
    id: "cloud",
    locality: "cloud",
    handler: (req) => {
      const convo = JSON.stringify(req.messages);
      if (convo.includes("stop now")) return { text: "stopping as asked" };
      if (turn++ >= 4) return { text: "done looking" };
      return { text: "", toolCalls: [{ id: `t${turn}`, name: "look", args: { where: "src" } }] };
    },
  });

  const agent = new Agent({
    router: new Router().bind("driver", port),
    tools: reg,
    subagents: false,
    maxSteps: 8,
    onEvent: (e) => {
      trace.push(e);
      if (e.type === "turn_end" && onTurn) onTurn(agent, e.n);
    },
  });
  return agent;
}

test("a steer sent mid-run lands at the next turn boundary", async () => {
  const trace: FeinTrace[] = [];
  const agent = agentThatLoops(trace, (a, turn) => {
    if (turn === 2) a.steer("stop now");
  });

  const run = await agent.run("keep looking");

  const applied = trace.find((e) => e.type === "steer_applied");
  assert.ok(applied, "the steer must be delivered");
  assert.equal((applied as { count: number }).count, 1);

  // It actually redirected the agent rather than being merely recorded.
  assert.match(run.text, /stopping as asked/);
  assert.ok(run.steps < 8, "it stopped early because the steer took effect");
});

test("the steer reaches the model as a framed user message", async () => {
  const trace: FeinTrace[] = [];
  const agent = agentThatLoops(trace, (a, turn) => {
    if (turn === 1) a.steer("stop now");
  });
  await agent.run("keep looking");

  const view = agent.view();
  const injected = view.find(
    (m) => m.role === "user" && /while you were working/.test(m.content),
  );
  assert.ok(injected, "the model must see it, framed as an interjection");
  assert.match((injected as { content: string }).content, /stop now/);
});

test("steering never breaks the prefix — it is an append", async () => {
  const trace: FeinTrace[] = [];
  const agent = agentThatLoops(trace, (a, turn) => {
    if (turn === 1) a.steer("one");
    if (turn === 2) a.steer("two");
  });
  await agent.run("go");

  assert.equal(
    agent.ledger.summary().cache.breaks.length,
    0,
    "a mid-run message must not rewrite history",
  );
});

test("turns are typed so a trace can explain a change of direction", async () => {
  const trace: FeinTrace[] = [];
  const agent = agentThatLoops(trace, (a, turn) => {
    if (turn === 2) a.steer("stop now");
  });
  await agent.run("go");

  const kinds = trace
    .filter((e) => e.type === "turn_start")
    .map((e) => (e as { kind: string }).kind);

  assert.equal(kinds[0], "user", "the opening turn");
  assert.equal(kinds[1], "continue", "the loop carrying on by itself");
  assert.ok(kinds.includes("steer"), "and the turn a correction arrived");
});

test("steering an idle agent arrives at the start of the next run", async () => {
  const trace: FeinTrace[] = [];
  const agent = agentThatLoops(trace, undefined);

  assert.equal(agent.isRunning, false);
  agent.steer("before we start: only look in test/");

  await agent.run("go");
  const view = agent.view();
  assert.ok(
    view.some((m) => m.role === "user" && /only look in test\//.test(m.content)),
    "a steer queued while idle is not lost",
  );
});

test("several steers queued during one turn arrive together", async () => {
  const trace: FeinTrace[] = [];
  const agent = agentThatLoops(trace, (a, turn) => {
    if (turn === 1) {
      a.steer("first thought");
      a.steer("second thought");
      a.steer("stop now");
    }
  });
  await agent.run("go");

  const applied = trace.find((e) => e.type === "steer_applied") as { count: number } | undefined;
  assert.equal(applied?.count, 3, "all three in one message, in order");

  const view = agent.view();
  const injected = view.find((m) => m.role === "user" && /first thought/.test(m.content));
  assert.match((injected as { content: string }).content, /1\. first thought/);
  assert.match((injected as { content: string }).content, /3\. stop now/);
});

test("a concurrent run is refused, and points at steer (regression)", async () => {
  // Two runs interleaving writes to the transcript make message order depend on
  // scheduling — the exact corruption steering exists to prevent. Before the
  // fix both runs succeeded and both user messages landed.
  const trace: FeinTrace[] = [];
  const agent = agentThatLoops(trace, undefined);

  const first = agent.run("first");
  await assert.rejects(() => agent.run("second"), /already running/);
  await assert.rejects(() => agent.run("third"), /agent\.steer/, "the error names the way out");

  await first;
  const users = agent.view().filter((m) => m.role === "user");
  assert.equal(users.length, 1, "only the accepted run wrote to the transcript");

  // And the agent is usable again afterwards.
  await agent.run("second, properly");
  assert.equal(agent.view().filter((m) => m.role === "user").length, 2);
});

test("a steer arriving at the last boundary reaches the wrap-up (regression)", async () => {
  // Before the fix it sat in the queue until some later run — the user's last
  // words silently not applied to the answer they were aimed at.
  const reg = new ToolRegistry().register({
    spec: { name: "look", description: "look", parameters: { type: "object", properties: {} } },
    async run() {
      return "same";
    },
  } as Tool);

  let agent: Agent;
  const port = new ScriptedPort({
    id: "cloud",
    locality: "cloud",
    handler: (req) => {
      const convo = JSON.stringify(req.messages);
      if (convo.includes("cannot take further actions")) {
        return { text: convo.includes("LATE") ? "wrapping up, noting your correction" : "wrapping up" };
      }
      return { text: "", toolCalls: [{ id: "t", name: "look", args: {} }] };
    },
  });

  agent = new Agent({
    router: new Router().bind("driver", port),
    tools: reg,
    subagents: false,
    maxSteps: 2,
    onEvent: (e) => {
      if (e.type === "turn_end" && e.n === 2) agent.steer("LATE correction");
    },
  });

  const run = await agent.run("go");
  assert.ok(
    agent.view().some((m) => m.role === "user" && /LATE correction/.test(m.content)),
    "the steer must reach the model",
  );
  assert.match(run.text, /noting your correction/, "and influence the answer it was aimed at");
});

test("steers queued after the run ends are deferred, not silently dropped", async () => {
  const trace: FeinTrace[] = [];
  const agent = agentThatLoops(trace, undefined);
  await agent.run("go");

  agent.steer("too late for that run");
  assert.equal(
    trace.filter((e) => e.type === "steer_deferred").length,
    0,
    "nothing was queued during the run itself",
  );

  // It is kept, and applied to the next run rather than lost.
  await agent.run("next");
  assert.ok(
    agent.view().some((m) => m.role === "user" && /too late for that run/.test(m.content)),
  );
});

test("isRunning reflects the run, so a caller can label queued vs sent", async () => {
  const trace: FeinTrace[] = [];
  let sawRunningDuringTurn = false;
  const agent = agentThatLoops(trace, (a) => {
    if (a.isRunning) sawRunningDuringTurn = true;
  });

  await agent.run("go");
  assert.equal(sawRunningDuringTurn, true);
  assert.equal(agent.isRunning, false, "cleared when the run ends");
});
