import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Transcript } from "../core/transcript.js";
import { MainLens } from "../context/lens.js";
import {
  repairTranscript,
  findUnpairedCalls,
  findOrphanResults,
} from "../context/repair.js";
import { spill, headTail, FileSpillStore, DEFAULT_SPILL_POLICY } from "../context/spill.js";
import { digest, chunkByLines, DEFAULT_DIGEST_POLICY } from "../steps/digester.js";
import { Router } from "../models/router.js";
import { ScriptedPort, estimateTokens } from "../models/providers/scripted.js";
import { Ledger } from "../telemetry/ledger.js";
import { SessionStore } from "../session/store.js";
import { PersistentSession } from "../session/persist.js";

const tmp = () => mkdtemp(join(tmpdir(), "fein-ctx-"));

// ── transcript repair ───────────────────────────────────────────────────────

test("an interrupted session is unresumable without repair", () => {
  // The exact shape a crash leaves behind: assistant asked, process died.
  const t = new Transcript();
  t.user("go");
  t.assistant("working", [{ id: "a", name: "read_file", args: {} }], "driver@x");

  const unpaired = findUnpairedCalls(t.channel("main"));
  assert.equal(unpaired.length, 1, "the call has no result — every provider rejects this");
  assert.equal(unpaired[0]!.id, "a");
});

test("repair backfills unanswered calls as real, honest events", () => {
  const t = new Transcript();
  t.user("go");
  t.assistant("", [
    { id: "a", name: "read_file", args: {} },
    { id: "b", name: "shell", args: {} },
  ], "driver@x");

  const report = repairTranscript(t);
  assert.equal(report.backfilled.length, 2);

  const rendered = new MainLens(false).render(t);
  const last = rendered[rendered.length - 1]!;
  assert.equal(last.role, "tool", "the conversation must not end on an unanswered call");

  const results = rendered.flatMap((m) => (m.role === "tool" ? m.results : []));
  assert.deepEqual(results.map((r) => r.callId).sort(), ["a", "b"]);
  for (const r of results) {
    assert.equal(r.isError, true, "an interruption is an error, not a silent success");
    assert.match(r.content, /never completed/);
  }
  // The log records what happened rather than hiding it.
  assert.ok(t.channel("main").some((e) => e.kind === "tool_result"));
});

test("repair is idempotent — resuming twice adds nothing", () => {
  const t = new Transcript();
  t.user("go");
  t.assistant("", [{ id: "a", name: "x", args: {} }], "driver@x");

  repairTranscript(t);
  const afterFirst = t.channel("main").length;
  const second = repairTranscript(t);

  assert.equal(second.backfilled.length, 0);
  assert.equal(t.channel("main").length, afterFirst, "no accumulating repair noise");
});

test("repair leaves a clean session untouched", () => {
  const t = new Transcript();
  t.user("go");
  t.assistant("", [{ id: "a", name: "x", args: {} }], "driver@x");
  t.toolResult({ callId: "a", content: "done", isError: false });

  const before = t.channel("main").length;
  const report = repairTranscript(t);
  assert.deepEqual(report.backfilled, []);
  assert.equal(t.channel("main").length, before);
});

test("orphan results are dropped from the view, kept in the log", () => {
  const t = new Transcript();
  t.user("go");
  // A result for a call that is nowhere in the log — unrepairable by appending.
  t.toolResult({ callId: "ghost", content: "from nowhere", isError: false });

  assert.deepEqual(findOrphanResults(t.channel("main")), ["ghost"]);

  const rendered = new MainLens(false).render(t);
  assert.equal(rendered.filter((m) => m.role === "tool").length, 0, "not rendered");
  assert.ok(t.channel("main").some((e) => e.kind === "tool_result"), "still in the log");
});

test("resume repairs automatically, and reports what it fixed", () => {
  const store = new SessionStore(":memory:");
  const s = PersistentSession.create(store, { title: "crashed" });
  s.transcript.user("go");
  s.transcript.assistant("", [{ id: "a", name: "shell", args: {} }], "driver@x");

  const resumed = PersistentSession.resume(store, s.id);
  assert.equal(resumed.lastRepair.backfilled.length, 1);

  const rendered = new MainLens(false).render(resumed.transcript);
  assert.equal(rendered[rendered.length - 1]!.role, "tool");

  // And the repair is durable — it was appended, so it persisted.
  const again = PersistentSession.resume(store, s.id);
  assert.equal(again.lastRepair.backfilled.length, 0, "the fix stuck");
  store.close();
});

// ── spill ───────────────────────────────────────────────────────────────────

const bulk = (n: number) =>
  Array.from({ length: n }, (_, i) => `line ${i} with some padding text here`).join("\n");

test("spill bounds the result, never exceeds the cap, never grows", async () => {
  const store = new FileSpillStore(await tmp());
  const text = bulk(400);
  const out = await spill({
    result: { callId: "x", content: text, isError: false },
    toolName: "shell",
    store,
    policy: { ...DEFAULT_SPILL_POLICY, maxInlineBytes: 1000 },
  });

  assert.equal(out.spilled, true);
  assert.ok(out.replacementBytes! <= 1000, `cap exceeded: ${out.replacementBytes}`);
  assert.ok(out.replacementBytes! < out.originalBytes, "spilling must never add bytes");
  assert.match(out.content!, /Omitted [\d,]+ bytes/);
  assert.match(out.content!, /use grep to search it/);
});

test("the full text is retrievable — spill is lossless", async () => {
  const store = new FileSpillStore(await tmp());
  const text = `${bulk(200)}\nNEEDLE_IN_THE_MIDDLE\n${bulk(200)}`;
  const out = await spill({
    result: { callId: "x", content: text, isError: false },
    toolName: "shell",
    store,
    policy: { ...DEFAULT_SPILL_POLICY, maxInlineBytes: 800 },
  });

  // The preview misses the middle — which is precisely why the digester still
  // earns its inference. Spill guarantees bounded and retrievable, not smart.
  assert.doesNotMatch(out.content!, /NEEDLE_IN_THE_MIDDLE/);
  assert.match(await readFile(out.path!, "utf8"), /NEEDLE_IN_THE_MIDDLE/);
});

test("spill is idempotent", async () => {
  const store = new FileSpillStore(await tmp());
  const policy = { ...DEFAULT_SPILL_POLICY, maxInlineBytes: 900 };
  const first = await spill({
    result: { callId: "x", content: bulk(400), isError: false },
    toolName: "shell",
    store,
    policy,
  });
  const second = await spill({
    result: { callId: "y", content: first.content!, isError: false },
    toolName: "shell",
    store,
    policy,
  });
  assert.equal(second.spilled, false, "a bounded result must not re-spill");
});

test("spill skips errors and exempt tools", async () => {
  const store = new FileSpillStore(await tmp());
  const policy = { ...DEFAULT_SPILL_POLICY, maxInlineBytes: 100 };

  const err = await spill({
    result: { callId: "x", content: bulk(200), isError: true },
    toolName: "shell",
    store,
    policy,
  });
  assert.equal(err.spilled, false, "the exact bytes matter most when it failed");

  const exempt = await spill({
    result: { callId: "x", content: bulk(200), isError: false },
    toolName: "read_file",
    store,
    policy,
  });
  assert.equal(exempt.spilled, false, "spilling read would loop: read → spill → read");
});

test("a cap too small for the notice keeps the original (regression)", async () => {
  // Before the fix this emitted ~189 bytes for a 40-byte cap. A "bounded"
  // result that silently exceeds its bound is worse than an unbounded one,
  // because everything downstream trusts the bound.
  const store = new FileSpillStore(await tmp());
  for (const cap of [40, 80, 120, 160]) {
    const out = await spill({
      result: { callId: "x", content: bulk(400), isError: false },
      toolName: "shell",
      store,
      policy: { ...DEFAULT_SPILL_POLICY, maxInlineBytes: cap },
    });
    if (out.spilled) {
      assert.ok(out.replacementBytes! <= cap, `cap ${cap} exceeded: ${out.replacementBytes}`);
    } else {
      assert.match(out.skipReason!, /too small|not be smaller/);
    }
  }
});

test("the cap holds across a wide range of sizes", async () => {
  const store = new FileSpillStore(await tmp());
  for (const cap of [300, 500, 1000, 4000, 8000]) {
    const out = await spill({
      result: { callId: "x", content: bulk(2000), isError: false },
      toolName: "shell",
      store,
      policy: { ...DEFAULT_SPILL_POLICY, maxInlineBytes: cap },
    });
    assert.equal(out.spilled, true, `expected a spill at cap ${cap}`);
    assert.ok(out.replacementBytes! <= cap, `cap ${cap} exceeded: ${out.replacementBytes}`);
    assert.ok(out.replacementBytes! < out.originalBytes);
  }
});

test("a failing spill store degrades to the original result", async () => {
  const broken = {
    async save(): Promise<string> {
      throw new Error("disk full");
    },
  };
  const out = await spill({
    result: { callId: "x", content: bulk(400), isError: false },
    toolName: "shell",
    store: broken,
    policy: { ...DEFAULT_SPILL_POLICY, maxInlineBytes: 500 },
  });
  assert.equal(out.spilled, false);
  assert.match(out.skipReason!, /disk full/);
});

test("headTail keeps both ends and stays within budget", () => {
  const text = Array.from({ length: 100 }, (_, i) => `L${i}`).join("\n");
  const out = headTail(text, 200, 0.7);
  assert.ok(Buffer.byteLength(out, "utf8") <= 200);
  assert.match(out, /^L0/, "keeps the head");
  assert.match(out, /L99$/, "keeps the tail");
  assert.match(out, /…/, "marks the omission");
});

test("headTail never splits a surrogate pair", () => {
  const text = "😀".repeat(100);
  for (const budget of [7, 9, 13, 21, 40]) {
    const out = headTail(text, budget, 0.7);
    assert.ok(Buffer.byteLength(out, "utf8") <= budget, `budget ${budget} exceeded`);
    // A lone surrogate survives a round trip through UTF-8 as U+FFFD, so an
    // exact round trip is the honest check — and it catches the real defect
    // (a half-emoji) rather than pattern-matching on code units.
    assert.equal(
      Buffer.from(out, "utf8").toString("utf8"),
      out,
      `budget ${budget} produced an unpaired surrogate`,
    );
  }
});

// ── digestion respects the digester's window ────────────────────────────────

test("chunkByLines splits on line boundaries and never mangles a line", () => {
  const text = Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n");
  const chunks = chunkByLines(text, 20);
  assert.ok(chunks.length > 1, "a text over budget must split");
  for (const c of chunks) {
    assert.ok(estimateTokens(c) <= 25, `chunk over budget: ${estimateTokens(c)}`);
  }
  // Nothing lost, nothing duplicated, order preserved.
  assert.equal(chunks.join("\n"), text);

  // A single line longer than the budget is emitted whole: one oversized chunk
  // is a bounded problem, a line cut in half is an unbounded one.
  assert.equal(chunkByLines("x".repeat(4000), 10).length, 1);
});

test("a local digester never exceeds its own context window (regression)", async () => {
  // Before: the whole result went to whatever model was bound. A 200k log to a
  // 32k local model fails, falls back to cloud, and sends 200k tokens there —
  // spending real money to save tokens.
  const huge = "line of routine output here\n".repeat(30000);
  let maxTokensInOneCall = 0;
  let cloudCalls = 0;

  const local = new ScriptedPort({
    id: "local",
    locality: "local",
    contextWindow: 32_768,
    handler: (req) => {
      maxTokensInOneCall = Math.max(
        maxTokensInOneCall,
        estimateTokens(JSON.stringify(req.messages)),
      );
      return { text: "partial" };
    },
  });
  const cloud = new ScriptedPort({
    id: "cloud",
    locality: "cloud",
    contextWindow: 200_000,
    handler: () => {
      cloudCalls++;
      return { text: "d" };
    },
  });

  const out = await digest({
    router: new Router().bind("digester", local, { fallbacks: [cloud] }),
    ledger: new Ledger(),
    transcript: new Transcript(),
    result: { callId: "x", content: huge, isError: false },
    toolName: "shell",
  });

  assert.equal(out.digested, true);
  assert.ok(maxTokensInOneCall < 32_768, `sent ${maxTokensInOneCall} tokens to a 32k model`);
  assert.equal(cloudCalls, 0, "it must not fall back to the expensive model");
});

test("a cloud digester declines chunked work rather than overpaying", async () => {
  // Spill already bounds what the driver sees, for free. So chunked cloud
  // digestion competes with an 8KB preview, not with 200k raw tokens — and
  // several full-price calls do not repay that within a session.
  let calls = 0;
  const cloud = new ScriptedPort({
    id: "cloud",
    locality: "cloud",
    contextWindow: 32_768,
    costPerMTokIn: 3,
    costPerMTokOut: 15,
    handler: () => {
      calls++;
      return { text: "d" };
    },
  });
  const ledger = new Ledger();

  const out = await digest({
    router: new Router().bind("digester", cloud),
    ledger,
    transcript: new Transcript(),
    result: { callId: "x", content: "line of output\n".repeat(30000), isError: false },
    toolName: "shell",
  });

  assert.equal(out.digested, false);
  assert.equal(calls, 0, "not one call, let alone several");
  assert.equal(ledger.summary().totalUsd, 0);
  assert.match(out.skipReason!, /spill already bounds/);
  assert.match(out.skipReason!, /local digester/, "the message says what to do instead");
});

test("an explicit maxChunks overrides the cloud default", async () => {
  let calls = 0;
  const cloud = new ScriptedPort({
    id: "cloud",
    locality: "cloud",
    contextWindow: 32_768,
    handler: () => {
      calls++;
      return { text: "d" };
    },
  });

  const out = await digest({
    router: new Router().bind("digester", cloud),
    ledger: new Ledger(),
    transcript: new Transcript(),
    result: { callId: "x", content: "line of output\n".repeat(20000), isError: false },
    toolName: "shell",
    policy: { ...DEFAULT_DIGEST_POLICY, maxChunks: 3 },
  });

  assert.equal(out.digested, true, "pinning maxChunks means you meant it");
  assert.ok(calls > 1, "it chunked");
  assert.match(out.text!, /not summarized/, "and still says what it skipped");
});

test("a single-chunk result still digests on cloud", async () => {
  // The decline is about *chunking*, not about cloud digesters in general.
  let calls = 0;
  const cloud = new ScriptedPort({
    id: "cloud",
    locality: "cloud",
    contextWindow: 200_000,
    handler: () => {
      calls++;
      return { text: "one test failed" };
    },
  });
  const out = await digest({
    router: new Router().bind("digester", cloud),
    ledger: new Ledger(),
    transcript: new Transcript(),
    result: { callId: "x", content: bulk(400), isError: false },
    toolName: "shell",
  });
  assert.equal(out.digested, true);
  assert.equal(calls, 1);
});

// ── the two composed ────────────────────────────────────────────────────────

test("lens prefers digest, falls back to preview, and always offers the locator", () => {
  const t = new Transcript();
  t.user("go");
  t.assistant("", [{ id: "a", name: "shell", args: {} }], "driver@x");
  const ev = t.toolResult({ callId: "a", content: bulk(500), isError: false });
  t.spill(ev.id, "HEAD…TAIL", "/tmp/spill/full.txt", 20000);

  // Spill only: the model sees the bounded preview.
  const preview = new MainLens(false).render(t).find((m) => m.role === "tool");
  assert.ok(preview && preview.role === "tool");
  assert.match(preview.results[0]!.content, /HEAD…TAIL/);

  // Add a digest: semantics win, but the locator survives so the model can
  // recover whatever the summary dropped.
  t.digest(ev.id, "one test failed", "digester@local");
  const digested = new MainLens(true).render(t).find((m) => m.role === "tool");
  assert.ok(digested && digested.role === "tool");
  assert.match(digested.results[0]!.content, /one test failed/);
  assert.match(digested.results[0]!.content, /\/tmp\/spill\/full\.txt/);
});
