# FEIN(FE!N): Hybrid local-and-cloud agent harness.

**The world's first hybrid local-and-cloud agent harness you'll find addictive.**

English · [日本語](./README.ja.md) · [Español](./README.es.md) · [中文](./README.zh.md)

---

Most agent harnesses buy every part of the loop from the same expensive vendor.
Deciding what to do next, compressing a 3,000-line test log, and gating a risky
command are treated as one job, priced as one job, and sent to one model.

FE!N splits the loop into **slots** and lets you bind a different model to each —
so a frontier model does the thinking while a 3B model on your laptop does the
reading. TypeScript, **zero runtime dependencies**, 160 tests.

```ts
import { Agent, Router, AnthropicPort, OllamaPort, defaultTools } from "fein";

const cloud = new AnthropicPort({ id: "cloud", model: "claude-sonnet-5",
                                  apiKey: process.env.ANTHROPIC_API_KEY,
                                  costPerMTokIn: 3, costPerMTokOut: 15 });
const local = new OllamaPort({ id: "local", model: "qwen2.5:3b" });

const router = new Router()
  .bind("driver",   cloud)                          // decides what happens
  .bind("digester", local, { fallbacks: [cloud] })  // compresses observations
  .bind("verifier", cloud);                         // gates subagent mutations

await new Agent({ router, tools: defaultTools() }).run("Why is the test suite failing?");
```

The loop code does not change when you rebind. Same harness, all-cloud,
all-local, or any mixture — with a ledger that tells you what the difference
actually cost.

## Try it in 30 seconds

No API key, no GPU, no network — every model in the demo is scripted, so what
you're watching is the harness:

```bash
npm install && npm run demo
```

```
bindings
  driver      cloud/sonnet-sim [cloud]
  digester    local/qwen3b-sim [local] -> cloud/sonnet-sim

[2] driver · cloud/sonnet-sim cloud
A TypeScript project. Running the test suite to find the failure.
  tool shell(command: "npm test") via driver
       ok $ npm test ok 1 - unit/parser handles case 1 …
  digest shell: 3100 → 43 tok (99% smaller · local/qwen3b-sim)
  cache: prefix stable — 3 msg reused, 2 new

ledger
calls 4  ·  $0.0024  ·  0.2s
  local    1 calls   $0.0000
  cloud    3 calls   $0.0024
  cache  hit 10.1%   saved $0.0011
```

The driver decided to run `npm test` **itself** — its authority is untouched —
but it never saw the 330-line log. A local model compressed it to 43 tokens
first. That saving compounds over every remaining turn, it reclaims context
window, and the raw log never left the machine.

## The slots

| Slot | Job | Why it's separable |
|---|---|---|
| `driver` | Decide what happens next | The hard reasoning. Keep it frontier. |
| `digester` | Compress bulky output before the driver sees it | Output smaller than input; the saving compounds; the raw data never leaves the machine |
| `verifier` | Gate a subagent's world-changing calls | Rare, so it can afford to be expensive |
| `titler` | Name the session | Trivial |

Any slot takes any model. Every slot takes a fallback chain, so a dead local
runtime degrades that slot to the cloud rather than taking the session down.

**There was a fifth slot and we deleted it.** A `toolformer` turned the driver's
one-line intent into concrete tool arguments. Measured, it cost **+11 to +15
driver output tokens on every call and saved zero** — the intent has to carry
the arguments verbatim, so it is structurally a superset of what it replaces.
The write-up with numbers is in [DESIGN.md](./DESIGN.md). The lesson:
**delegate a stage only when the delegate can produce more than it was given, or
knows something the caller does not.**

## Subagent or slot?

Not competitors — they differ in how much control you surrender:

| | Unit | Fixed overhead | What you give up |
|---|---|---|---|
| **Subagent** | A whole task | ~600–900 tok/spawn, fresh context, cold cache | Every intermediate decision |
| **Slot** | One stage of one decision | ~150 tok | Nothing |

Reading forty files to find one symbol → **subagent**. "Run *this exact command*
and its output is 20k tokens" → **slot**; you cannot hand that to a subagent
without also handing over the choice of command. A few tool calls you could make
yourself → **neither**.

## Keeping the cache hot

Hybrid execution creates a hazard pure-cloud harnesses don't have: it is very
easy to save tokens in a way that costs more than it saves, by rewriting history
the provider had already cached. FE!N treats prefix stability as an invariant,
not an aspiration:

- **Render monotonicity** — every render strictly extends the last. `PrefixGuard`
  hashes each render and reports a break the moment one happens, attributed to
  the slot that caused it. Cache misses become reproducible bugs, not a bill.
- **Checked prompt sections** — the system prompt is assembled from named parts
  with declared volatility, and `SectionGuard` catches a "frozen" section that
  changed. `PrefixGuard` says *the prefix broke at message 4*; `SectionGuard`
  says *the `identity` section changed between turns*. The second is actionable.
- **Lookback-aware anchors** — a breakpoint reaches back only 20 *content
  blocks*, and one turn with six parallel tool calls is thirteen. Two such turns
  put the previous anchor out of reach and you pay full price forever, silently.
- **Append instead of edit** — `registerDeferred` + `surfaceTool()` add a tool
  mid-session without touching the tool block; `injectContext()` adds operator
  context as a system-role message rather than editing the system prompt.
- **Epochs, not sliding windows** — dropping old messages shifts every token
  after them and misses on *every* subsequent turn, forever.
- **Ordered concurrency** — parallel tool results append in call order, never
  completion order, so the transcript never depends on machine timing.

## Bounded observations

Two mechanisms, deliberately layered, because the free one should run first.

**Spill** (model-free): oversized tool output is written to `.fein/spill/` and
replaced with a head/tail preview plus a path the model can `grep`. Lossless,
idempotent, never exceeds its cap, never grows.

**Digest** (one inference): a local model compresses the full text semantically.

They are complementary, and the fixture proves it — a 332-line log with the one
failure on line 241: the preview **misses it**, the digester finds it. So both
run, and the lens prefers `digest → preview → raw`. Spill also fixes the
digester's worst property: a summary that dropped a detail now has a route back
to the source.

Digestion is **chunked to the digester's context window**, and the chunk cap is
locality-aware — a local digester reads 16 chunks (marginal cost is wall-clock),
a cloud one declines chunked work outright, because spill already bounded the
damage for free. That constant is the hybrid argument in miniature.

## ReAct

A local model can *drive*, not just assist. `ReactPort` wraps any text-only
model and presents a native tool-calling interface, so the loop never learns
ReAct exists — it moves tools into the prompt, rewrites history into the
Thought/Action/Observation transcript the model speaks, stops generation before
the model can invent its own `Observation:`, and repairs malformed output
locally.

That last point is the classic ReAct failure and it is silent: left alone, a
model will happily write `Observation: the file contains…` and reason about a
result no tool produced. The fix is mechanical — a stop sequence — not a polite
request.

## Steering

Type while it works. Your line lands at the **next turn boundary**, never
mid-turn: injecting between an Action and its Observation would hand the model a
user message where a tool result belongs. A second concurrent `run()` is refused,
because two writers interleaving on the transcript make message order depend on
scheduling — which breaks the cache intermittently and undebuggably.

## Loop hygiene

A ReAct loop rarely fails by crashing. It fails by *continuing* — calling the
same tool, getting the same answer, reasoning about it again. Every turn looks
reasonable; only the sequence is insane, and the model cannot see its own loop
from the inside.

`LoopGuard` catches repeats, oscillation (A→B→A→B), and stalling. The
discriminator is **same call, same result** — repeating a call whose answer
changed is legitimate (polling a build, retrying a flake), so it never fires on
real work. Each problem warns once; a guard that repeats itself is another loop.

Running out of turns forces a real answer with **no tools offered** rather than
returning a leftover fragment. Removing the capability is a guarantee; asking is
a request.

## Beyond the loop

All discovered from the workspace — nothing requires a config file.

**Durable sessions** (`node:sqlite`, no dependency). `fein chat --resume <id>`
replays them. Compaction is a **fork**: the epoch spawns a child seeded by the
summary, the parent keeps every event, the link is recorded. "Compacted" means
*relocated*, not *lost*. A session interrupted between a tool call and its result
is repaired on resume — otherwise it is not merely degraded but permanently
unresumable, since every provider rejects an unanswered tool call.

**Recall** — FTS5 search across every prior session, exposed as `session_search`
rather than auto-injected behind the model's back. Tool output is deliberately
not indexed, so recall returns decisions instead of log lines.

**Identity vs. convention** — `~/.fein/SOUL.md` is who the agent is; it is
*yours*, so it is trusted. A `SOUL.md` in the repo is fenced like any project
file, because the trust boundary is who can write the file, not what it's called.

**Skills** — reusable procedures as Markdown. The *index* lives in the frozen
prompt; *bodies* load on demand. Loading every body up front burns tokens on
unused skills and means writing a skill invalidates every cached conversation.

**Hooks** — functions and/or executables in `.fein/hooks/<event>/`. `beforeTool`
can **deny**; a hook that can only observe is a logging system, not a safety
mechanism. Observability hooks that throw are ignored; a `beforeTool` hook that
throws **fails closed**.

**Subagents** — depth capped *in code*, and a `SpawnBudget` shared by reference
across the whole tree. A per-agent limit is not a limit: breadth^depth growth
measured 40 agents from a "cap" of 3.

**Scheduled jobs** — durable POSIX cron under the *same* permission machinery as
interactive work, read-only unless you pass `--write`. No backfill: a laptop
closed overnight wakes to zero pending runs, not eleven.

```bash
fein chat [--resume <id>]     fein run "<prompt>"     fein demo
fein sessions list | show <id> | search <q> | lineage <id>
fein skills list | show <name>          fein hooks
fein cron list | add | rm | enable | disable | runs | run | serve
```

## Workspace

```
~/.fein/SOUL.md                     who the agent is (trusted, tier 1)
.fein/sessions.db  .fein/jobs.db    durable sessions + scheduled jobs
.fein/skills/  .fein/hooks/<event>/ skills + lifecycle hooks
.fein/spill/                        bulky tool output, retrievable
AGENTS.md | CLAUDE.md | SOUL.md     project context (fenced, tier 2)
```

## Layout

```
src/
  core/        types · transcript (append-only log) · loop · guards · steering
  context/     lens + PrefixGuard · spill · repair
  models/      router · react-port · providers/{anthropic,openai,ollama,scripted}
  steps/       digester · verifier · subagent · react · prompts · sections
  tools/       registry · builtin · edit/glob/grep
  cache/       limits (breakpoints, lookback, minimums) · keeper
  session/     store (SQLite+FTS5) · persist · search-tool
  skills/      hooks/      schedule/      telemetry/ledger
  config/      profiles · workspace        cli/       bench/
```

See [ARCHITECTURE.md](./ARCHITECTURE.md) for why these boundaries, and
[DESIGN.md](./DESIGN.md) for the reasoning behind each rule — including an
honest list of what is still unsolved.

## Tests and benchmark

```bash
npm test               # 160 tests
npm run bench          # offline, deterministic, free — mechanism cost
npm run bench:live     # real models — the correctness question
```

The benchmark prices each mechanism against a control on tasks chosen so each
has a case it should win and a case where it can only cost. Measured: the
digester is **88% cheaper on its case, 43% more expensive where it cannot help**,
netting **−58%** across four tasks. It paid for itself immediately by catching a
bug where the digester ran, billed, and had its output silently discarded.

Requires Node ≥ 22.5 (for built-in `node:sqlite`).

---

## References

FE!N was built after reading four open-source harnesses side by side. All are
MIT-licensed. **No code was copied** — the value was in design decisions, and
every adoption is a fresh implementation with its own invariants and tests.
[COMPARISON.md](./COMPARISON.md) documents what was taken, what was declined,
and what survived contact unchanged.

- **[deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)** —
  "everything is a plugin." Taught us **spill** (bounded preview + retrieval
  locator, model-free), model-free result pruning, loop-hygiene guards, and the
  principle that a canonical order matters because it is a cache prefix.
- **[pi](https://github.com/earendil-works/pi)** — layered agent packages.
  Taught us the **turn as a first-class concept** (one assistant response plus
  its tool calls) and a nested event taxonomy.
- **[nanobot](https://github.com/HKUDS/nanobot)** — a deliberately small,
  readable core. Taught us **steering** (mid-turn message injection via a queue
  rather than a racing second run), typed turns, and the defensive passes that
  make a persisted history safe to replay — which surfaced a real bug where an
  interrupted session was permanently unresumable.
- **[hermes-agent](https://github.com/NousResearch/hermes-agent)** — sessions as
  infrastructure, deep context engineering. Taught us **named prompt sections**
  (which turned our own headline invariant from a convention into a checked
  one), a **rotation-stable cache scope** derived from the compaction lineage
  root, using the provider's real reported usage instead of a character
  estimate, and bounded error-body reads.

Also informed by the published behavior of Claude Code and Codex, and by
Anthropic's prompt-caching documentation for the breakpoint, lookback, TTL, and
minimum-prefix rules encoded in `src/cache/limits.ts`.

## License

MIT © Ziboyan Wang
