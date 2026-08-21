# FE!N — Source Layout

The tree is grouped by *concern*, not by file type. Each directory answers one
question, and the dependency arrows only ever point downward — `core` never
imports `cli`, `context` never imports `models`.

```
src/
├── core/                 What an agent IS
│   ├── types.ts            IR: messages, tool calls, ModelPort, events
│   ├── transcript.ts       append-only event log — the single source of truth
│   └── loop.ts             the agent loop
│
├── context/              What a model SEES
│   ├── lens.ts             transcript → messages, + PrefixGuard (cache tripwire)
│   ├── spill.ts            model-free bounding: preview + retrieval locator
│   └── repair.ts           makes an interrupted session resumable
│
├── models/               WHO does the work
│   ├── router.ts           slot → model binding, fallback chains
│   └── providers/          transports (the plugin surface)
│       ├── anthropic.ts      explicit cache_control, tool_addition blocks
│       ├── openai.ts         OpenAI/DeepSeek/vLLM/llama.cpp/LM Studio
│       ├── ollama.ts         native, keep_alive tuned for residency
│       └── scripted.ts       deterministic + offline; simulates prefix caching
│
├── steps/                The swappable STAGES of the loop
│   ├── prompts.ts          every string here is a cache prefix — see the header
│   ├── observe.ts          compress observations before first render
│   ├── verify.ts           gate a subagent's side-effecting calls
│   └── subagent.ts         bounded recursive delegation
│
├── tools/                What the agent can DO
│   ├── registry.ts         registration, freezing, schema validation, dispatch
│   └── builtin.ts          read_file / list_dir / write_file / shell
│
├── cache/                Cache POLICY (not wire format)
│   ├── limits.ts           breakpoint ceiling, lookback, minimums, economics
│   └── keeper.ts           TTL heartbeat (max_tokens: 0)
│
├── session/              DURABILITY, lineage, and recall
│   ├── store.ts            SQLite + FTS5 (node:sqlite — no dependency)
│   ├── persist.ts          Transcript → store sink; epoch forks a child
│   └── search-tool.ts      session_search / session_lineage, model-facing
│
├── skills/               Accumulated procedural knowledge
│   └── skill.ts            index in the prompt, bodies on demand
│
├── hooks/                Lifecycle INTERCEPTION
│   └── hooks.ts            in-process fns + executables; beforeTool can veto
│
├── schedule/             Durable CRON
│   ├── cron.ts             job store + POSIX cron parsing
│   └── runner.ts           tick loop, no backfill, no self-overlap
│
├── telemetry/            Where the CLAIMS get checked
│   └── ledger.ts           cost by locality/slot, hit rate, offload, breaks
│
├── config/
│   ├── profiles.ts         hybrid / cloud-only / local-only wiring
│   └── workspace.ts        discovers .fein/, assembles a full agent
│
├── cli/
│   ├── main.ts             command dispatch
│   ├── commands.ts         sessions / skills / hooks / cron
│   ├── render.ts           trace renderer
│   └── demo.ts             offline scripted walkthrough
│
├── bench/                Does any of this actually pay?
│   ├── fixtures/           synthetic repo with known contents
│   ├── tasks.ts            mechanically checkable answers, no LLM judge
│   ├── configs.ts          the control + one row per mechanism
│   └── run.ts · report.ts  matrix runner, deltas against the control
│
├── test/
└── index.ts              public API, grouped to mirror this tree
```

## Why these boundaries

**`core` vs `context`.** The transcript is what *happened*; the lens is what a
particular binding is *shown*. Keeping them apart is what makes digest
substitution and per-binding views possible without ever mutating history — and
history immutability is the whole cache guarantee.

**`cache/limits.ts` is not inside `models/providers/`.** The breakpoint ceiling,
the 20-block lookback, and the per-model minimums are *policy* the loop and lens
need to reason about, not details of one transport. Putting them in the
Anthropic file made them look provider-specific and hid them from the code that
actually has to respect them.

**`steps/` is flat and small on purpose.** Each file is one slot. If a slot's
implementation grows past a few hundred lines, that is a signal it is doing
something the loop should own instead.

**`telemetry/` is its own layer** because the project makes two empirical
claims (delegation saves money, the cache stays hot) and both have to be
measurable by something that isn't the thing making the claim.

**`session/` is not inside `core/`.** Persistence is a *sink* on the
append-only log, never load-bearing for correctness: every guarantee the loop
makes holds identically in memory. Keeping it outside `core` is what keeps that
true — `core` cannot reach for the database, so it cannot come to depend on it.

**`hooks/` sits beside the loop, not inside it.** The loop calls hooks; hooks
never call the loop. That one-way edge is why a broken hook degrades a session
instead of corrupting it.

## The workspace

Everything durable lives under the workspace root and is *discovered*, never
required:

```
.fein/sessions.db          durable sessions + full-text recall
.fein/jobs.db              scheduled jobs
.fein/skills/<name>/SKILL.md
.fein/hooks/<event>/<executable>
AGENTS.md | CLAUDE.md | .cursorrules    project context (prompt tier 2)
```

`openWorkspace()` in `config/workspace.ts` assembles all of it. A directory
with none of these still works — that is the point.

## What is still missing

| Not built | Would live in | Why not |
|---|---|---|
| Messaging gateways (Slack/Telegram/…) | `src/gateway/` | Real work, but orthogonal to the hybrid-routing thesis |
| Profiles (isolated agent roots) | `src/config/` | Thin wrapper over workspace roots; not yet needed |
| Vector recall alongside FTS | `src/session/` | FTS covers keyword recall; semantic recall needs an embedding model choice |

See DESIGN.md §7 for the honest status of the harder open problems.
