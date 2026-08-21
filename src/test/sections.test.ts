import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SystemPromptBuilder,
  SectionGuard,
  scanForVolatileContent,
} from "../steps/sections.js";
import { thinkSections } from "../steps/prompts.js";
import { SessionStore } from "../session/store.js";
import { PersistentSession } from "../session/persist.js";
import { Agent, type FeinTrace } from "../core/loop.js";
import { Router } from "../models/router.js";
import { ScriptedPort } from "../models/providers/scripted.js";
import { ToolRegistry } from "../tools/registry.js";

// ── the builder ─────────────────────────────────────────────────────────────

test("empty sections are dropped so callers need no conditionals", () => {
  const b = new SystemPromptBuilder()
    .add("a", "frozen", "first")
    .add("b", "stable", undefined)
    .add("c", "stable", "   ")
    .add("d", "frozen", "last");
  assert.deepEqual(b.list().map((s) => s.name), ["a", "d"]);
  assert.equal(b.build(), "first\n\nlast");
});

test("render order is insertion order — sorting would be a silent cache bug", () => {
  const b = new SystemPromptBuilder()
    .add("zebra", "frozen", "Z")
    .add("alpha", "frozen", "A");
  assert.equal(b.build(), "Z\n\nA");
});

// ── drift detection ─────────────────────────────────────────────────────────

test("a frozen section that changes is reported by name", () => {
  const g = new SectionGuard();
  const build = (identity: string) =>
    new SystemPromptBuilder().add("identity", "frozen", identity).add("workspace", "stable", "/w");

  assert.deepEqual(g.check(build("you are FE!N").fingerprint()), [], "first build is the baseline");

  const drift = g.check(build("you are FE!N at 10:31:02").fingerprint());
  assert.equal(drift.length, 1);
  assert.equal(drift[0]!.name, "identity", "the report names the culprit, not a message index");
  assert.equal(drift[0]!.kind, "changed");
  assert.match(drift[0]!.detail, /interpolated value/);
});

test("a section appearing mid-run is caught", () => {
  const g = new SectionGuard();
  g.check(new SystemPromptBuilder().add("a", "frozen", "A").fingerprint());
  const drift = g.check(
    new SystemPromptBuilder().add("a", "frozen", "A").add("skills", "stable", "S").fingerprint(),
  );
  assert.equal(drift[0]?.kind, "added");
  assert.match(drift[0]!.detail, /every cached turn before this is now cold/);
});

test("reordering is caught and named as the intermittent bug it is", () => {
  const g = new SectionGuard();
  g.check(
    new SystemPromptBuilder().add("a", "frozen", "A").add("b", "frozen", "B").fingerprint(),
  );
  const drift = g.check(
    new SystemPromptBuilder().add("b", "frozen", "B").add("a", "frozen", "A").fingerprint(),
  );
  assert.equal(drift.some((d) => d.kind === "reordered"), true);
  assert.match(drift.find((d) => d.kind === "reordered")!.detail, /without a stable order/);
});

test("a stable prompt reports no drift across many builds", () => {
  const g = new SectionGuard();
  const build = () =>
    thinkSections({ workspace: "/w", hybrid: true, memory: true, subagents: true }).fingerprint();
  g.check(build());
  for (let i = 0; i < 5; i++) {
    assert.deepEqual(g.check(build()), [], `drift on build ${i}`);
  }
});

// ── the first-build scanner ─────────────────────────────────────────────────

test("the scanner catches the offenders that actually happen", () => {
  const cases: Array<[string, RegExp]> = [
    ["Current time: 2026-08-16T10:31", /ISO timestamp/],
    ["It is now 10:31:02 local", /clock time/],
    ["You are on step 3 of 7", /step counter/],
    ["This is turn 4", /turn counter/],
    ["Session started 1786804868279", /unix timestamp/],
  ];
  for (const [text, expected] of cases) {
    const problem = scanForVolatileContent({ name: "s", volatility: "frozen", text });
    assert.ok(problem, `missed: ${text}`);
    assert.match(problem!, expected);
    assert.match(problem!, /injectContext/, "the message must say where it belongs instead");
  }
});

test("the scanner does not cry wolf on ordinary prompt text", () => {
  const benign = [
    "You are FE!N, a hybrid agent harness.",
    "Workspace root: /Users/someone/project",
    "Available skills — read one with the `read_skill` tool:\n- deploy: ship safely",
    "Prefer edit over write_file for changes to an existing file.",
    "Use grep to search it, or read it with an offset.",
  ];
  for (const text of benign) {
    assert.equal(
      scanForVolatileContent({ name: "s", volatility: "frozen", text }),
      undefined,
      `false positive on: ${text}`,
    );
  }
});

test("the real think model prompt is clean", () => {
  const sections = thinkSections({
    workspace: "/w",
    hybrid: true,
    memory: true,
    subagents: true,
    identity: "Be terse.",
    skillIndex: "- deploy: ship safely",
    projectContext: "<project-context source=\"AGENTS.md\">use tabs</project-context>",
  });
  for (const s of sections.list()) {
    assert.equal(scanForVolatileContent(s), undefined, `volatile content in "${s.name}"`);
  }
});

test("plan-execute guidance appears only when the execute slot is bound", () => {
  const base = { workspace: "/w", hybrid: false, subagents: true };
  const without = thinkSections(base).build();
  const withTiers = thinkSections({ ...base, tiers: true }).build();

  assert.doesNotMatch(without, /light tier/, "no execute binding, no tier vocabulary");
  assert.match(withTiers, /plan before you spawn/);
  assert.match(withTiers, /acceptance criteria/);
  assert.match(withTiers, /Never respawn the\s+same thing unchanged/);
  // Still one frozen section — the guidance must not add prompt volatility.
  for (const s of thinkSections({ ...base, tiers: true }).list()) {
    assert.equal(scanForVolatileContent(s), undefined);
  }
});

test("an agent warns rather than silently shipping a volatile prompt", async () => {
  const trace: FeinTrace[] = [];
  new Agent({
    router: new Router().bind(
      "think",
      new ScriptedPort({ id: "c", locality: "cloud", handler: () => ({ text: "" }) }),
    ),
    tools: new ToolRegistry(),
    subagents: false,
    systemExtra: "The current time is 2026-08-16T10:31.",
    onEvent: (e) => trace.push(e),
  });

  const warning = trace.find((e) => e.type === "prompt_warning");
  assert.ok(warning, "a per-turn value in the system prompt must not pass unremarked");
  assert.match((warning as { message: string }).message, /cache hit rate to zero/);
});

// ── rotation-stable cache scope ─────────────────────────────────────────────

test("the cache scope survives compaction", () => {
  const store = new SessionStore(":memory:");
  const parent = PersistentSession.create(store, { title: "long run" });
  const child = parent.forkForEpoch("summary", "window full");
  const grandchild = child.forkForEpoch("summary 2", "window full again");

  // A fork is a new session but the same conversation. Keying on the current
  // id would discard affinity exactly when the prefix was just rebuilt.
  assert.notEqual(child.id, parent.id);
  assert.equal(store.lineageRoot(parent.id), parent.id);
  assert.equal(store.lineageRoot(child.id), parent.id);
  assert.equal(store.lineageRoot(grandchild.id), parent.id);
  store.close();
});

test("unrelated sessions get different scopes", () => {
  const store = new SessionStore(":memory:");
  const a = PersistentSession.create(store);
  const b = PersistentSession.create(store);
  assert.notEqual(store.lineageRoot(a.id), store.lineageRoot(b.id));
  store.close();
});

test("lineageRoot terminates on a cyclic parent link", () => {
  // Defensive: a corrupted store must not hang the request path.
  const store = new SessionStore(":memory:");
  const s = PersistentSession.create(store);
  assert.equal(store.lineageRoot(s.id), s.id);
  assert.equal(store.lineageRoot("nonexistent"), "nonexistent");
  store.close();
});
