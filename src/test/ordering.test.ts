import { test } from "node:test";
import assert from "node:assert/strict";
import { Router } from "../models/router.js";
import { ScriptedPort } from "../models/providers/scripted.js";
import { ToolRegistry, type Tool } from "../tools/registry.js";
import { Agent } from "../core/loop.js";
import { CacheKeeper } from "../cache/keeper.js";
import { Ledger } from "../telemetry/ledger.js";

/**
 * These tests defend the property that makes concurrency safe here: the
 * transcript — and therefore the prompt prefix — must not depend on how fast
 * the machine happened to be.
 */

function slowTool(name: string, delayMs: number, sideEffects = false): Tool {
  return {
    spec: {
      name,
      description: `Return ${name} after ${delayMs}ms.`,
      parameters: { type: "object", properties: {} },
      ...(sideEffects ? { sideEffects: true } : {}),
    },
    async run() {
      await new Promise((r) => setTimeout(r, delayMs));
      return `result-of-${name}`;
    },
  };
}

test("parallel tool results are appended in call order, not completion order", async () => {
  // slow_a finishes last but was called first: it must still appear first.
  const reg = new ToolRegistry()
    .register(slowTool("slow_a", 40))
    .register(slowTool("fast_b", 1))
    .register(slowTool("mid_c", 15));

  const cloud = new ScriptedPort({
    id: "cloud",
    locality: "cloud",
    handler: (_r, turn) =>
      turn === 0
        ? {
            text: "",
            toolCalls: [
              { id: "t1", name: "slow_a", args: {} },
              { id: "t2", name: "fast_b", args: {} },
              { id: "t3", name: "mid_c", args: {} },
            ],
          }
        : { text: "done" },
  });

  const agent = new Agent({
    router: new Router().bind("driver", cloud),
    tools: reg,
    maxSteps: 3,
  });
  await agent.run("run all three");

  const toolMessages = agent.view().filter((m) => m.role === "tool");
  const contents = toolMessages.flatMap((m) =>
    m.role === "tool" ? m.results.map((r) => r.content) : [],
  );
  assert.deepEqual(contents, ["result-of-slow_a", "result-of-fast_b", "result-of-mid_c"]);
});

test("the same batch produces an identical transcript across runs", async () => {
  const build = () => {
    const reg = new ToolRegistry()
      .register(slowTool("a", 30))
      .register(slowTool("b", 2))
      .register(slowTool("c", 12));
    const cloud = new ScriptedPort({
      id: "cloud",
      locality: "cloud",
      handler: (_r, turn) =>
        turn === 0
          ? {
              text: "",
              toolCalls: [
                { id: "t1", name: "a", args: {} },
                { id: "t2", name: "b", args: {} },
                { id: "t3", name: "c", args: {} },
              ],
            }
          : { text: "done" },
    });
    return new Agent({ router: new Router().bind("driver", cloud), tools: reg, maxSteps: 3 });
  };

  const a1 = build();
  const a2 = build();
  await a1.run("go");
  await a2.run("go");
  assert.equal(JSON.stringify(a1.view()), JSON.stringify(a2.view()));
});

test("side-effecting calls are serialized against reads", async () => {
  const order: string[] = [];
  const trace = (name: string, delayMs: number, sideEffects = false): Tool => ({
    spec: {
      name,
      description: name,
      parameters: { type: "object", properties: {} },
      ...(sideEffects ? { sideEffects: true } : {}),
    },
    async run() {
      order.push(`${name}:start`);
      await new Promise((r) => setTimeout(r, delayMs));
      order.push(`${name}:end`);
      return name;
    },
  });

  const reg = new ToolRegistry()
    .register(trace("read1", 20))
    .register(trace("mutate", 5, true))
    .register(trace("read2", 20));

  const cloud = new ScriptedPort({
    id: "cloud",
    locality: "cloud",
    handler: (_r, turn) =>
      turn === 0
        ? {
            text: "",
            toolCalls: [
              { id: "t1", name: "read1", args: {} },
              { id: "t2", name: "mutate", args: {} },
              { id: "t3", name: "read2", args: {} },
            ],
          }
        : { text: "done" },
  });

  await new Agent({ router: new Router().bind("driver", cloud), tools: reg, maxSteps: 3 }).run("go");

  // The mutation must not begin until the preceding read has finished.
  assert.ok(
    order.indexOf("read1:end") < order.indexOf("mutate:start"),
    `mutation raced a read: ${order.join(" ")}`,
  );
});

test("CacheKeeper stops after maxRefreshes and records its own cost", async () => {
  let calls = 0;
  const port = new ScriptedPort({
    id: "cloud",
    locality: "cloud",
    costPerMTokIn: 3,
    costPerMTokOut: 15,
    handler: () => {
      calls++;
      return { text: "." };
    },
  });
  const ledger = new Ledger();
  const keeper = new CacheKeeper({
    port,
    ledger,
    intervalMs: 5,
    maxRefreshes: 3,
  });
  keeper.arm({ system: "s", messages: [{ role: "user", content: "hi" }] });
  keeper.start();
  await new Promise((r) => setTimeout(r, 60));
  keeper.stop();

  assert.equal(calls, 3, "must stop at maxRefreshes rather than warming forever");
  assert.equal(ledger.summary().calls, 3, "heartbeats must appear in the ledger, not be hidden");
});

test("CacheKeeper.touch cancels pending heartbeats when the user acts", async () => {
  let calls = 0;
  const port = new ScriptedPort({
    id: "cloud",
    locality: "cloud",
    handler: () => {
      calls++;
      return { text: "." };
    },
  });
  const keeper = new CacheKeeper({ port, intervalMs: 10, maxRefreshes: 5 });
  keeper.arm({ system: "s", messages: [] });
  keeper.start();
  keeper.touch();
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(calls, 0);
});
