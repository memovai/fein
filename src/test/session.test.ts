import { test } from "node:test";
import assert from "node:assert/strict";
import { SessionStore, sanitizeFtsQuery } from "../session/store.js";
import { PersistentSession } from "../session/persist.js";
import { sessionSearchTool, sessionLineageTool } from "../session/search-tool.js";
import { Router } from "../models/router.js";
import { ScriptedPort } from "../models/providers/scripted.js";
import { ToolRegistry } from "../tools/registry.js";
import { Agent } from "../core/loop.js";

const ctx = { cwd: process.cwd(), allowSideEffects: true };
const mem = () => new SessionStore(":memory:");

test("events survive the process: append then reload", () => {
  const store = mem();
  const s = PersistentSession.create(store, { title: "first" });
  s.transcript.user("remember the deploy key is in vault X");
  s.transcript.assistant("Noted.", [], "driver@test");

  const reloaded = store.loadEvents(s.id);
  assert.equal(reloaded.length, 2);
  assert.equal(reloaded[0]!.kind, "user");
  store.close();
});

test("resume replays without re-persisting", () => {
  const store = mem();
  const a = PersistentSession.create(store, { title: "t" });
  a.transcript.user("one");
  a.transcript.assistant("two", [], "driver@test");
  assert.equal(store.eventCount(a.id), 2);

  const b = PersistentSession.resume(store, a.id);
  assert.equal(b.transcript.all.length, 2, "history is in the transcript");
  assert.equal(store.eventCount(a.id), 2, "replay must not duplicate rows");

  // And new events still persist after a resume.
  b.transcript.user("three");
  assert.equal(store.eventCount(a.id), 3);
  store.close();
});

test("search finds prior decisions across sessions", () => {
  const store = mem();
  const s1 = PersistentSession.create(store, { title: "infra" });
  s1.transcript.user("we decided to use postgres for the ledger, not sqlite");
  const s2 = PersistentSession.create(store, { title: "unrelated" });
  s2.transcript.user("fix the CSS on the landing page");

  const hits = store.search("postgres ledger");
  assert.ok(hits.length >= 1);
  assert.equal(hits[0]!.sessionId, s1.id);
  assert.match(hits[0]!.text, /postgres/);
  store.close();
});

test("search excludes the current session so recall is about the past", () => {
  const store = mem();
  const s1 = PersistentSession.create(store, { title: "old" });
  s1.transcript.user("the deployment target is fly.io");
  const s2 = PersistentSession.create(store, { title: "new" });
  s2.transcript.user("the deployment target is fly.io");

  const all = store.search("deployment target");
  const excluded = store.search("deployment target", { excludeSession: s2.id });
  assert.equal(all.length, 2);
  assert.equal(excluded.length, 1);
  assert.equal(excluded[0]!.sessionId, s1.id);
  store.close();
});

test("bulky tool output is not indexed — recall returns decisions, not logs", () => {
  const store = mem();
  const s = PersistentSession.create(store);
  s.transcript.assistant("", [{ id: "a", name: "shell", args: {} }], "driver@test");
  s.transcript.toolResult({ callId: "a", content: "ERROR ERROR ERROR ".repeat(200), isError: false });
  s.transcript.user("the build is failing on ERROR handling");

  const hits = store.search("error");
  assert.equal(hits.length, 1, "only the user message should be indexed");
  assert.equal(hits[0]!.kind, "user");
  store.close();
});

test("FTS query sanitization survives punctuation and operators", () => {
  // These are all FTS5 syntax errors if passed through raw.
  for (const q of ['what about "quotes"?', "a AND b OR NOT c", "path/to/file.ts", "!!!"]) {
    const s = sanitizeFtsQuery(q);
    const store = mem();
    if (s) {
      assert.doesNotThrow(() => store.search(q), `raw query broke FTS: ${q}`);
    }
    store.close();
  }
  assert.equal(sanitizeFtsQuery("the a of"), "", "stopwords-only reduces to empty, not a syntax error");
});

test("epoch forks a child session and records lineage", () => {
  const store = mem();
  const parent = PersistentSession.create(store, { title: "long run" });
  parent.transcript.user("original detailed work");

  const child = parent.forkForEpoch("SUMMARY OF THE WORK", "window full");

  assert.notEqual(child.id, parent.id);
  assert.equal(child.row().parentId, parent.id);
  assert.equal(child.row().generation, 1);
  // Parent keeps everything; child starts from the summary.
  assert.equal(store.eventCount(parent.id), 1);
  assert.equal(store.loadEvents(child.id)[0]!.kind, "epoch");

  const chain = store.lineage(child.id);
  assert.deepEqual(chain.map((s) => s.id), [child.id, parent.id]);
  store.close();
});

test("compacted detail stays searchable through the parent", () => {
  const store = mem();
  const parent = PersistentSession.create(store, { title: "run" });
  parent.transcript.user("the retry budget must never exceed three attempts");
  const child = parent.forkForEpoch("Summary: discussed retries.", "window full");

  // The specific number fell out of the child's context, but not off the disk.
  const hits = store.search("retry budget attempts", { excludeSession: child.id });
  assert.ok(hits.length >= 1);
  assert.match(hits[0]!.text, /three attempts/);
  store.close();
});

test("session_search tool reports absence honestly", async () => {
  const store = mem();
  const tool = sessionSearchTool(store);
  const out = await tool.run({ query: "quantum tunnelling" }, ctx);
  assert.match(out, /No prior sessions/);
  store.close();
});

test("session_lineage tool explains an uncompacted session", async () => {
  const store = mem();
  const s = PersistentSession.create(store);
  const tool = sessionLineageTool(store, () => s.id);
  assert.match(await tool.run({}, ctx), /not been compacted/);

  const child = s.forkForEpoch("sum", "full");
  const tool2 = sessionLineageTool(store, () => child.id);
  const out = await tool2.run({}, ctx);
  assert.match(out, /generation\(s\) back/);
  assert.match(out, /compacted because: full/);
  store.close();
});

test("an agent with a session persists its whole run", async () => {
  const store = mem();
  const session = PersistentSession.create(store, { title: "run" });
  const cloud = new ScriptedPort({
    id: "cloud",
    locality: "cloud",
    handler: () => ({ text: "all done" }),
  });
  const agent = new Agent({
    router: new Router().bind("driver", cloud),
    tools: new ToolRegistry(),
    session,
    subagents: false,
    maxSteps: 2,
  });
  await agent.run("do a thing");

  const events = store.loadEvents(session.id);
  assert.ok(events.some((e) => e.kind === "user"));
  assert.ok(events.some((e) => e.kind === "assistant"));
  assert.equal(agent.session?.id, session.id);
  store.close();
});
