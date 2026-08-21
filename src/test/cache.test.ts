import { test } from "node:test";
import assert from "node:assert/strict";
import { AnthropicPort } from "../models/providers/anthropic.js";
import { cacheMinimumFor, CACHE_LOOKBACK_BLOCKS } from "../cache/limits.js";
import { Router } from "../models/router.js";
import { ScriptedPort } from "../models/providers/scripted.js";
import { ToolRegistry, type Tool } from "../tools/registry.js";
import { Agent } from "../core/loop.js";
import { MainLens } from "../context/lens.js";
import { Transcript } from "../core/transcript.js";
import type { ChatMessage, ToolCall } from "../core/types.js";

/**
 * These exercise the Anthropic wire format directly, because every one of
 * these properties is invisible at runtime: get them wrong and the API still
 * returns 200, the agent still works, and the only symptom is a bill.
 */

/** Capture the request body an AnthropicPort would send, without a network. */
async function captureBody(
  port: AnthropicPort,
  messages: ChatMessage[],
  opts: { system?: string; tools?: unknown[] } = {},
): Promise<Record<string, unknown>> {
  const original = globalThis.fetch;
  let captured: Record<string, unknown> = {};
  globalThis.fetch = (async (_url: string, init: { body: string }) => {
    captured = JSON.parse(init.body) as Record<string, unknown>;
    return {
      ok: true,
      json: async () => ({ content: [{ type: "text", text: "ok" }], usage: {} }),
    };
  }) as unknown as typeof fetch;
  try {
    await port.complete({
      system: opts.system ?? "sys",
      messages,
      ...(opts.tools ? { tools: opts.tools as never } : {}),
    });
  } finally {
    globalThis.fetch = original;
  }
  return captured;
}

function countAnchors(body: Record<string, unknown>): number {
  let n = 0;
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) return void v.forEach(walk);
    if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      if (o["cache_control"]) n++;
      Object.values(o).forEach(walk);
    }
  };
  walk(body["system"]);
  walk(body["tools"]);
  walk(body["messages"]);
  return n;
}

const port = () => new AnthropicPort({ id: "c", model: "claude-sonnet-5", apiKey: "k" });

test("never exceeds the 4 cache_control breakpoint limit", async () => {
  // A long, tool-heavy conversation: the case most likely to over-anchor.
  const messages: ChatMessage[] = [];
  for (let i = 0; i < 40; i++) {
    messages.push({ role: "user", content: `turn ${i}` });
    messages.push({
      role: "assistant",
      content: "",
      toolCalls: Array.from({ length: 5 }, (_, j) => ({
        id: `t${i}_${j}`,
        name: "x",
        args: {},
      })) as ToolCall[],
    });
    messages.push({
      role: "tool",
      results: Array.from({ length: 5 }, (_, j) => ({
        callId: `t${i}_${j}`,
        content: "r",
        isError: false,
      })),
    });
  }
  const body = await captureBody(port(), messages, {
    tools: [{ name: "x", description: "d", parameters: { type: "object", properties: {} } }],
  });
  const n = countAnchors(body);
  assert.ok(n <= 4, `emitted ${n} breakpoints; the API accepts at most 4`);
  assert.ok(n >= 3, `emitted only ${n} breakpoints; budget is being wasted`);
});

test("message anchors stay within the 20-block lookback window", async () => {
  // Each turn here is 11 content blocks (1 assistant text-or-calls + 5 tool_use
  // ... + 5 tool_result). Without lookback-aware placement, consecutive
  // anchors would sit far more than 20 blocks apart and silently never hit.
  const messages: ChatMessage[] = [];
  for (let i = 0; i < 12; i++) {
    messages.push({
      role: "assistant",
      content: "",
      toolCalls: Array.from({ length: 5 }, (_, j) => ({ id: `t${i}_${j}`, name: "x", args: {} })),
    });
    messages.push({
      role: "tool",
      results: Array.from({ length: 5 }, (_, j) => ({
        callId: `t${i}_${j}`,
        content: "r",
        isError: false,
      })),
    });
  }
  const body = await captureBody(port(), messages);

  // Walk the rendered messages counting blocks, recording anchor positions.
  const anchorBlockPositions: number[] = [];
  let blocks = 0;
  for (const m of body["messages"] as Array<{ content: unknown }>) {
    const content = Array.isArray(m.content) ? m.content : [m.content];
    for (const b of content) {
      blocks++;
      if (b && typeof b === "object" && (b as Record<string, unknown>)["cache_control"]) {
        anchorBlockPositions.push(blocks);
      }
    }
  }

  assert.ok(anchorBlockPositions.length >= 2, "expected multiple message anchors");
  for (let i = 1; i < anchorBlockPositions.length; i++) {
    const gap = anchorBlockPositions[i]! - anchorBlockPositions[i - 1]!;
    assert.ok(
      gap <= CACHE_LOOKBACK_BLOCKS,
      `anchors ${gap} blocks apart exceeds the ${CACHE_LOOKBACK_BLOCKS}-block lookback`,
    );
  }
});

test("the primary anchor sits on settled history, not the moving edge", async () => {
  const messages: ChatMessage[] = [
    { role: "user", content: "a" },
    { role: "assistant", content: "b" },
    { role: "user", content: "c" },
  ];
  const body = await captureBody(port(), messages);
  const rendered = body["messages"] as Array<{ content: unknown }>;
  const last = rendered[rendered.length - 1]!;
  const lastBlocks = Array.isArray(last.content) ? last.content : [last.content];
  const lastAnchored = lastBlocks.some(
    (b) => b && typeof b === "object" && (b as Record<string, unknown>)["cache_control"],
  );
  assert.equal(lastAnchored, false, "anchoring the moving edge writes a fresh entry every turn");
});

test("1h TTL is emitted when configured", async () => {
  const p = new AnthropicPort({
    id: "c",
    model: "claude-sonnet-5",
    apiKey: "k",
    cacheTtl: "1h",
  });
  const body = await captureBody(p, [{ role: "user", content: "hi" }]);
  const system = body["system"] as Array<Record<string, unknown>>;
  assert.deepEqual(system[0]!["cache_control"], { type: "ephemeral", ttl: "1h" });
});

test("cache minimums are model-specific and not guessable from version order", () => {
  assert.equal(cacheMinimumFor("claude-opus-5"), 512);
  assert.equal(cacheMinimumFor("claude-opus-4-8"), 1024);
  assert.equal(cacheMinimumFor("claude-opus-4-7"), 2048);
  // Non-monotonic: the *older* 4.6 has a higher minimum than 4.7 and 4.8.
  assert.equal(cacheMinimumFor("claude-opus-4-6"), 4096);
  assert.ok(cacheMinimumFor("claude-opus-4-6") > cacheMinimumFor("claude-opus-4-8"));
  assert.equal(cacheMinimumFor("some-unknown-model"), 1024);
});

// --- mid-conversation changes ----------------------------------------------

function noopTool(name: string, deferred = false): Tool {
  return {
    spec: {
      name,
      description: name,
      parameters: { type: "object", properties: {} },
      ...(deferred ? { deferLoading: true } : {}),
    },
    async run() {
      return name;
    },
  };
}

test("surfacing a deferred tool appends rather than rewriting the prefix", async () => {
  const reg = new ToolRegistry().register(noopTool("always")).registerDeferred(noopTool("later"));
  const cloud = new ScriptedPort({
    id: "cloud",
    locality: "cloud",
    handler: () => ({ text: "done" }),
  });
  const agent = new Agent({ router: new Router().bind("think", cloud), tools: reg, maxSteps: 2 });

  await agent.run("first");
  const before = agent.view();

  agent.surfaceTool("later");
  const after = agent.view();

  // Strict extension: everything the think model already saw is untouched.
  assert.deepEqual(after.slice(0, before.length), before);
  const added = after[after.length - 1]!;
  assert.equal(added.role, "system");
  assert.deepEqual(
    added.role === "system" ? added.toolChanges : undefined,
    [{ op: "add", tool: "later" }],
  );
});

test("surfacing a non-deferred or unknown tool is refused", () => {
  const reg = new ToolRegistry().register(noopTool("always"));
  const cloud = new ScriptedPort({ id: "c", locality: "cloud", handler: () => ({ text: "" }) });
  const agent = new Agent({ router: new Router().bind("think", cloud), tools: reg });

  assert.throws(() => agent.surfaceTool("always"), /not deferred/);
  assert.throws(() => agent.surfaceTool("nope"), /unknown tool/);
});

test("deferred tools are declared up front with defer_loading", async () => {
  const reg = new ToolRegistry().register(noopTool("always")).registerDeferred(noopTool("later"));
  const body = await captureBody(port(), [{ role: "user", content: "x" }], {
    tools: reg.specs() as unknown[],
  });
  const tools = body["tools"] as Array<Record<string, unknown>>;
  const later = tools.find((t) => t["name"] === "later")!;
  const always = tools.find((t) => t["name"] === "always")!;
  assert.equal(later["defer_loading"], true);
  assert.equal(always["defer_loading"], undefined);
});

test("tool changes render as tool_addition blocks on a system message", async () => {
  const t = new Transcript();
  t.user("go");
  t.toolChange("add", "later");
  t.toolChange("remove", "always");
  const rendered = new MainLens(false).render(t);
  const body = await captureBody(port(), rendered);
  const messages = body["messages"] as Array<{ role: string; content: unknown }>;

  const add = messages.find(
    (m) =>
      m.role === "system" &&
      Array.isArray(m.content) &&
      (m.content[0] as Record<string, unknown>)["type"] === "tool_addition",
  );
  const remove = messages.find(
    (m) =>
      m.role === "system" &&
      Array.isArray(m.content) &&
      (m.content[0] as Record<string, unknown>)["type"] === "tool_removal",
  );
  assert.ok(add, "expected a tool_addition block");
  assert.ok(remove, "expected a tool_removal block");
});

test("injected context is a system-role message, not a rewritten system prompt", async () => {
  const reg = new ToolRegistry().register(noopTool("t"));
  const cloud = new ScriptedPort({ id: "c", locality: "cloud", handler: () => ({ text: "ok" }) });
  const agent = new Agent({ router: new Router().bind("think", cloud), tools: reg, maxSteps: 2 });

  await agent.run("hello");
  const before = agent.view();
  agent.injectContext("The user switched to terse mode.");
  const after = agent.view();

  assert.deepEqual(after.slice(0, before.length), before, "must be an append");
  const last = after[after.length - 1]!;
  assert.equal(last.role, "system");
  assert.match(last.role === "system" ? last.content : "", /terse mode/);
});
