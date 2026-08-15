# What FE!N learned from four other harnesses

Four open-source agent harnesses read side by side against FE!N, to find
foundational things we were missing. All four are MIT-licensed. **No code was
copied** — the value here is in the design decisions, and every adoption below
is a fresh implementation in FE!N's own idiom, with our own invariants and
tests. Where a design taught us something, it is credited.

| Harness | Language | Shape |
|---|---|---|
| [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`) | TypeScript, ~2280 files | "Everything is a plugin" — 40+ capability packages over a DI kernel |
| [pi](https://github.com/earendil-works/pi) | TypeScript, ~1130 files | Layered npm packages: `ai` (provider API) → `agent` (loop) → `coding-agent` (CLI) |
| [nanobot](https://github.com/HKUDS/nanobot) | Python, ~4k core lines | Deliberately minimal, readable core; many channels |
| [hermes-agent](https://github.com/NousResearch/hermes-agent) | Python, ~4250 files | Sessions as infrastructure; deep context engineering |

---

## The one finding that mattered most

**We reach for a model to solve problems that do not need one.**

FE!N's answer to "this tool returned 3000 lines" was always the digester: spend
an inference, get a summary. Both `dsh` and `hermes` treat that as the *second*
tier, behind model-free mechanisms:

- `dsh` has **spill** (persist the full text, show a bounded preview plus a
  retrieval locator) and a **tool-result pruner** (head + marker + tail, no
  model).
- `hermes` has `prune_tool_results_only` as a distinct, cheaper step before
  summarizing compaction.

That is a real gap, not a stylistic difference. An inference costs money, sits
on the critical path, and is **lossy in a way nobody can undo**. Truncation with
a retrieval path costs nothing and loses nothing.

### Adopted: `src/context/spill.ts`

Oversized tool output is written to `.fein/spill/`, and the model sees a
head/tail preview plus the path with a "grep it or read it with an offset" hint.

The invariants are ours and are tested:

1. The replacement **never exceeds the cap** — the notice's byte cost is
   reserved out of the budget before the preview is sized.
2. The replacement is **never larger than the original**; spilling must not add
   bytes.
3. **Idempotent** — a spilled result is under the cap, so a second pass is a
   no-op and notices cannot accumulate.
4. **Best-effort** — a write failure returns the original result. A full disk
   must never turn a successful call into an error.
5. Errors are never spilled, and `read_file` is exempt — otherwise the retrieval
   hint sends the model to `read` the spill file, whose output spills again.
   `dsh` documents that loop explicitly; it is the kind of thing you only learn
   by having shipped it.

**Spill and digest turned out to be complementary rather than competing**, which
we only saw once both existed. Our own benchmark fixture proves it: a 332-line
log with the one failure on line 241 — the head/tail preview **misses it**, and
the digester finds it. Conversely a digest is a paraphrase, and if it drops the
line number that detail is gone.

So FE!N now does both, and the lens prefers `digest → preview → raw`:

```
no digester bound  →  bounded preview + locator     (was: unbounded raw text)
digester bound     →  semantic digest + locator     (was: digest, detail gone)
```

The second row is the real win: **spill fixes the digester's worst property.** A
summary that drops something now has a route back to the source, which turns
"lossy" into "summarized, with the truth one tool call away."

---

## The bug this exercise found

`nanobot`'s `ContextGovernor` is a set of defensive passes over persisted
history before it goes back to a provider — among them `drop_orphan_tool_results`
and `backfill_missing_tool_results`.

That pointed straight at a bug FE!N had shipped. We added durable sessions and
`--resume` earlier; we did not consider what a session interrupted **between a
tool call and its result** looks like on disk. The answer: an assistant turn with
an unanswered `tool_use`, which every provider rejects. The session is not
degraded, it is **permanently unresumable** — every later request 400s, with an
error pointing at the request rather than at the crash that caused it.

Confirmed with a probe before fixing: a resumed transcript ended with two
unpaired calls and zero results.

### Adopted: `src/context/repair.ts`

- **Unanswered calls are backfilled** with synthetic error results, appended as
  real events. Appending rather than hiding is the honest choice: the log then
  says the call never completed, the model is told so in words it can act on,
  and an auditor sees the interruption instead of a suspiciously tidy history.
- **Orphan results** (a result whose call is nowhere in the log) cannot be
  repaired by appending — there is nothing to pair them with — so they are
  dropped at render and kept in the log.
- Runs at resume, **before the first render**, which is the same timing
  constraint digestion obeys (DESIGN.md §2 Rule 2).
- Idempotent, so it can run on every resume unconditionally.

---

## Also adopted

**Real usage instead of a character estimate** (from `hermes`'s
`should_compress_preflight` / `should_defer_preflight_to_real_usage`). FE!N
triggered compaction from `estimateTokens` = chars/4, and DESIGN.md §7 listed
that as an open problem. But the provider reports the true prompt size on every
response and we were discarding it. Now the estimate is used only until the first
real answer arrives; after that we anchor on the provider's number. This closes
a §7 item outright.

**Bounded error-body reads** (from `hermes`'s `bounded_response`). Our providers
did `await res.text()` on a non-OK response — unbounded in two ways: a server can
stream an arbitrarily large body, or open it and stall forever. The body is only
ever shown truncated in an error message, so `src/models/providers/http.ts` now
caps bytes and enforces a wall-clock deadline.

---

## Considered and deliberately not adopted

| Pattern | Source | Why not |
|---|---|---|
| Plugin/DI kernel for everything | `dsh` | The right architecture at their scale (40+ packages, many teams). At ours it would add a layer of indirection over ~45 files and obscure the thing that makes FE!N legible: you can read the loop top to bottom. Revisit if third parties start shipping FE!N plugins. |
| Messaging gateways (Slack/Telegram/…) | `nanobot`, `hermes` | Real work, genuinely useful, and orthogonal to the hybrid-routing thesis. A surface, not a foundation. |
| TUI | `pi`, `hermes` | Same. Our trace renderer is deliberately a log, because the thing worth showing is *who served what*. |
| Binary wire protocol | `pi` | Solves multi-client/daemon problems we do not have. |
| Event bus | `nanobot` | Our `onEvent` callback plus the hook runner covers the same need at our size. A bus is what you add when subscribers outnumber the loop's authors. |
| Sandboxing | `dsh`, `hermes` | Important and large. Our answer today is trust tiers plus hooks plus read-only defaults; a real sandbox is a separate project. |
| MCP client | `dsh`, `nanobot`, `hermes` | The biggest genuine gap. Large enough to deserve its own effort rather than being wedged in here. See below. |

---

## What FE!N still lacks that all four have

**MCP.** Every one of the four speaks Model Context Protocol; FE!N does not.
This is the largest remaining gap and it is an ecosystem gap rather than an
architectural one — our `ToolRegistry` is the natural attachment point, and the
`deferLoading` + `surfaceTool()` mechanism already solves the hard part (adding
tools mid-session without invalidating the prompt cache), which most harnesses
do *not* solve. Worth doing next.

**Todo/plan state.** `dsh` and `nanobot` both expose a session task list as a
model-facing tool. Cheap, and a real aid on long tasks.

**Loop-hygiene guards.** `dsh`'s `repeat-tool-reminder` watches for the same call
being made repeatedly and nudges; `timeout-policy` arms per-call deadlines. Both
are small and address failure modes we currently have no answer for.

---

## What survived contact unchanged

Worth stating, because the exercise could have concluded otherwise:

- **Slot decomposition per loop stage.** None of the four does this. `dsh`
  swaps models as plugins, `pi` normalizes providers, but the unit is the whole
  loop. Binding a *stage* to a model remains FE!N's distinctive claim.
- **Cache discipline as an enforced invariant.** `hermes` protects head and tail
  with token budgets and `dsh` has compaction seams, but neither treats prefix
  monotonicity as a tested invariant with a tripwire (`PrefixGuard`), nor
  handles the 20-block lookback window, nor uses deferred-tool surfacing to keep
  a dynamic tool set cache-safe.
- **Two prompt tiers, not three.** `dsh` has a `time-context` plugin that injects
  the current time as *request context* rather than into the system prompt —
  independently arriving at the same conclusion FE!N reached from the cache
  side. Confirmation rather than a lesson.
- **The ledger.** None of the four prices per-slot, per-locality spend the way
  ours does. Given that our thesis is economic, that instrument stays central.
