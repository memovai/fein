# FE!N — Design Notes

> **fein (FE!N): the world's first hybrid local-and-cloud agent harness you'll find addictive.**

This document explains why FE!N is built the way it is. It is opinionated on
purpose: most of these decisions have a cheaper-looking alternative that is
wrong in a way you only discover after you have been paying for it for a month.

---

## 1. The thesis: the model is a component of the loop, not its owner

Almost every agent harness has this shape:

```
model.chat(messages, tools)  ->  tool calls  ->  execute  ->  append  ->  repeat
```

One model does everything: it decides what to do, formats the arguments, reads
the raw output, summarizes when the context fills up, and names the session.
The harness is plumbing around a single mind.

That is a strange arrangement, because those jobs have almost nothing in common.
Deciding *what to do next* is the hardest reasoning in the loop. Turning
"read the package manifest" into `read_file({path: "package.json"})` is
transcription. Compressing a 3000-line test log while preserving the one failing
line is extraction. These have wildly different difficulty, wildly different
token profiles, and wildly different consequences when they go wrong — and yet
we buy them all from the same expensive vendor at the same price.

FE!N splits the loop into **slots** and lets any model fill any slot:

| Slot | Job | Difficulty | Natural home |
|---|---|---|---|
| `think` | Decide what happens next | Hard reasoning | Cloud frontier model |
| `observe` | Compress bulky observations | Extraction | Local 3–7B |
| `verify` | Gate a subagent's mutation | Judgment, rare | Cloud (cheap because it is rare) |
| `title` | Name the session | Trivial | Anything |

The names follow ReAct's Thought/Observation vocabulary — see the README's slot
section for why there is no `action` slot.

```ts
router
  .bind("think",   cloudSonnet)
  .bind("observe", localQwen3B, { fallbacks: [cloudSonnet] })
  .bind("verify",  cloudSonnet);
```

The loop code does not change when you rebind. That is the whole point: the
same harness runs all-cloud, all-local, or any mixture, and you can measure the
difference instead of arguing about it.

### Why the observe model is the highest-value delegation

Of everything a small local model could do in this loop, exactly one job has all
four of the properties that make delegation pay:

1. **Its output is smaller than its input.** This is the whole game and it is
   rarer than it sounds. A stage that takes a short input and produces a short
   output cannot save you anything — there is nothing to compress. The observe
   model takes 3000 tokens and returns 200.

2. **The saving compounds.** A tool result does not cost you once. It sits in
   the prompt prefix for every remaining turn of the session. Compressing 20k to
   200 is a saving multiplied by however many turns are left — and it reclaims
   context window, which is scarcer than money.

3. **The think model's authority is untouched.** The observe model runs on the *return*
   path, after the think model already chose the command and the tool already ran. It
   changes what the think model reads, never what the think model decided. That is what
   makes it composable with everything else.

4. **The data never leaves the machine.** This is the one a cheap *cloud* model
   cannot give you at any price. A 20k-line log full of customer records, stack
   traces, and internal hostnames is summarized locally; only the summary
   crosses the network. Swap the local observe model for a cheap cloud subagent and
   you have saved the same tokens while shipping every byte to a vendor.

The guard rails matter as much as the mechanism. Errors are never digested — a
summarized stack trace is a debugging disaster, and the exact bytes matter
precisely when things went wrong. The raw output is always retained in the
transcript, so a digest is a *view*, not a deletion. And a digest that is not
meaningfully smaller is discarded, because paying for a call that returns a
paraphrase of the truth is worse than not calling at all.

### What we removed, and why — the toolformer

An earlier version of FE!N had a fifth slot. The think model would emit an *intent*
(`delegate({tool: "shell", intent: "run npm test"})`) and a local model would
materialize the concrete arguments. The argument was: arguments are verbose,
the decision behind them is short, so stop paying frontier prices for typing.

**That argument is the right shape and it is wrong.** We measured it, and it is
worth recording rather than quietly deleting.

The intent must contain enough information to reconstruct the arguments. Our own
toolformer prompt said so explicitly — *"copy concrete values verbatim"*,
*"never invent a path that was not given to you"* — and the local model was
given no directory listing, no file contents, no transcript. It had strictly
*less* information than the think model. **It could not compress, because it could
not expand.** Information cannot be created from nothing.

Measured across every realistic call in this codebase:

| Call | Direct | Via `delegate` | Δ |
|---|---|---|---|
| `shell({command:"npm test"})` | ~7 tok | ~18 tok | **+11** |
| `read_file({path:"package.json"})` | ~8 tok | ~23 tok | **+15** |
| `list_dir({path:"src/steps"})` | ~7 tok | ~21 tok | **+14** |

Never cheaper. Not once. Plus three costs that do not show up as output tokens:

- The `delegate` schema was **171 tokens — 68% the size of the entire toolset it
  delegated to** — in every request, permanently.
- `shell` and `write_file` are side-effecting, so every delegated call to them
  took an extra verify-model round trip. `shell` was the tool the schema explicitly
  advertised for delegation.
- **The think model's context never learned which command actually ran.** It saw an
  intent and a result; the real arguments went to the UI trace only. A context
  regression on top of a token regression.

No experiment flips this — the constraint is logical, not empirical. Deleting it
made the demo cheaper ($0.0128 → $0.0118) for an identical outcome.

The lesson generalizes: **delegate a stage only when the delegate can produce
more than it was given, or knows something the caller does not.** The observe model
qualifies on the first count. A future "local resolver" — one that holds a
workspace index and can turn "the config file" into a concrete path, eliminating
a lookup turn the think model would otherwise spend — would qualify on the second.
Pure transcription qualifies on neither.

### Measured

`npm run bench` runs a task × configuration matrix against a fixture workspace,
offline and deterministically. Four tasks, chosen so each mechanism has a case
it should win and a case where it can only cost:

```
                    cloud in/out   local in/out   usd        Δ vs control
failing-test — 3k-token log, one line matters
  cloud-only        3.5k/18        —              $0.01037   —
  cloud+local-digest  519/18       3.4k/41        $0.00126   -88%
dep-version — control; no mechanism can help
  cloud-only          327/2        —              $0.00070   —
  cloud+local-digest  509/2        —              $0.00100   +43%

summary (all four tasks)
  cloud-only          $0.01402
  cloud+local-digest  $0.00592     -58%
```

Both halves matter and the report prints both. The observe model is **88% cheaper on
its case** and **43% more expensive on a task it cannot help with**, because its
tool schema and its paragraph of system prompt are paid on every request whether
or not it fires. Net across the four: 58% cheaper, because the bulky case
dominates in absolute terms. That is the honest shape of the claim — not "local
models make everything cheaper", but "compression pays enormously where there is
something to compress, and costs a little everywhere else."

The benchmark earned its cost immediately: it found a bug where the observe model ran,
billed, and had its output discarded. `maybeCompact()` rendered through the real
lens to estimate context size, which *froze* every event (Rule 2's mechanism);
the subsequent real render then saw frozen events and fell back to raw. The
symptom was identical cloud token counts with and without an observe model bound —
invisible in every test we had, obvious the moment two configurations were
priced side by side.

### Choosing a delegation boundary

Three mechanisms now overlap, and picking between them is the most common design
question in this codebase. They differ in **how much control you surrender**:

| | Unit of delegation | Fixed overhead | What you give up |
|---|---|---|---|
| **Subagent** | A whole task | ~600–900 tok/spawn, fresh context, cold cache | Every intermediate decision |
| **Slot** | One stage of one decision | ~150 tok | Nothing |
| **Neither** | — | 0 | — |

The rule:

> Delegate to a **subagent** when the work's context footprint exceeds the spawn
> floor *and* you do not need to steer mid-task. Reading forty files to find one
> symbol: the parent should not see thirty-nine of them.
>
> Delegate to a **slot** when you must keep the decision but the data is bulky.
> "Run *this exact command*, and its output is 20k tokens" cannot go to a
> subagent without also handing over the choice of command.
>
> Do **neither** when the work is a few tool calls you could make yourself. Each
> spawn re-establishes context from nothing and you pay for that twice.

A third mechanism belongs on this table and is not built: **programmatic tool
calling**, where the think model emits a *script* that orchestrates many tool calls,
intermediates stay in the execution environment, and only the final result
returns. For "read fifty files and find X" it beats a subagent outright — no
fresh system prompt, no natural-language round trip, and the filtering is
deterministic. See §7.


---

## 2. KV cache: the constraint that shapes everything else

This is the part most hybrid designs get wrong, and it is worth being precise
about the mechanism before the rules.

### How prompt caching actually works

Cloud providers cache the transformer's key/value tensors for a prompt
**prefix**. On the next request they compare your prompt to cached entries and
reuse the KV state for the longest matching prefix, then process only the
remainder.

The critical properties:

- It is a **prefix** match, not a similarity match. One changed token at
  position 12 invalidates positions 12 through the end. There is no partial
  credit and no fuzzy matching.
- It is keyed on the **serialized request**, including the system prompt, the
  tool definitions, and message order — not just the conversation text.
- Reads are ~0.1x the input price (Anthropic) or ~0.5x (OpenAI). Anthropic
  cache *writes* cost 1.25x at the 5-minute TTL, or 2x at the 1-hour TTL.
  Break-even is two requests at 5m, three at 1h.
- Invalidation is **tiered**, not all-or-nothing: `tools` → `system` →
  `messages`. Changing `tool_choice` or toggling thinking invalidates only the
  message tier; changing the system prompt costs system + messages; changing
  tool *definitions* or the model costs everything. This matters because it
  means some things you might fear are actually free.

So the entire game is: **make turn N+1's prompt start with turn N's prompt,
byte for byte.** Everything below follows from that one sentence.

Two constraints are worth stating separately, because both fail *silently* —
the request succeeds, the agent works, and only the bill tells you:

- **A prefix below the model's minimum never caches at all.** The minimum is
  512 tokens on Opus 5, 1024 on Opus 4.8 and Sonnet 5, 2048 on Opus 4.7, and
  4096 on Opus 4.6 and Haiku 4.5. Note that is *not* monotonic — the older 4.6
  has an eight-times higher minimum than Opus 5 — so it cannot be inferred from
  a version number. `cacheMinimumFor()` carries the table.
- **Each breakpoint searches backward at most 20 content blocks.** See Rule 7.

### Rule 1 — Render monotonicity

> Every render for a given binding must be a strict extension of the previous
> render for that binding.

This is enforced structurally, not by convention. `MainLens` renders the
transcript, and `PrefixGuard` hashes each rendered message and compares against
the previous render. If a render fails to extend its predecessor, we emit a
loud `cache: PREFIX BROKE at message N` and record it in the ledger with the
slot that caused it.

This matters because cache misses are otherwise *invisible*. Everything works;
the bill is just higher than you expected, and nobody can say why. A tripwire
converts a silent financial leak into a reproducible bug with a line number.

### Rule 2a — Bound without a model before you bound with one

FE!N's first instinct was to spend an inference on every bulky observation. That
is the right tool for extracting meaning and the wrong one for the simpler job
of keeping 3000 lines out of the window, because an inference costs money, sits
on the critical path, and is lossy in a way nobody can undo.

**Spill** does that job free and losslessly: write the full text to a file, show
a bounded head/tail preview, and hand the model the path with a retrieval hint.

The two are complementary, and our own fixture proves it — a 332-line log with
the failure on line 241: the preview **misses it**, the observe model finds it.
Conversely a digest is a paraphrase, and what it drops is gone. So we do both,
and the lens prefers `digest -> preview -> raw`:

```
no observe model  ->  bounded preview + locator      (was: unbounded raw text)
observe model     ->  semantic digest + locator      (was: digest, detail gone)
```

The second row matters most: **spill fixes the observe model's worst property.** A
summary that dropped something now has a route back to the source.

Invariants, all tested: the replacement never exceeds the cap (the notice's
bytes are reserved before the preview is sized), never grows, is idempotent, and
degrades to the original on any write failure. Errors are never spilled, and
`read_file` is exempt — otherwise the retrieval hint sends the model to `read`
the spill file, whose output spills again.

### Rule 2b — A resumed transcript must be repaired before it is rendered

Durable sessions introduce a failure mode that cannot exist in memory: a session
interrupted **between a tool call and its result** leaves an assistant turn with
an unanswered `tool_use`, which every provider rejects. The session is not
degraded — it is permanently unresumable, and the error points at the request
rather than at the crash three days ago that caused it.

Resume therefore repairs: unanswered calls are backfilled with synthetic error
results **appended as real events**, so the log says the call never completed
rather than hiding it. Orphan results — a result whose call is nowhere in the
log — cannot be repaired by appending and are dropped at render instead.

Repair runs before the first render, the same timing constraint Rule 2 imposes,
and is idempotent so it can run on every resume unconditionally.

### Rule 2 — Digest before first render, or never

Here is the trap that makes naive "local model summarizes for cloud model"
designs backfire.

The obvious implementation: tool returns 20k tokens, hand it to the local model,
substitute the summary in the think model's context. Saves 20k cloud tokens. Ship it.

But if the raw output has *already been rendered* to the think model once,
substituting the digest **rewrites history**. The provider's cached prefix
diverges at that message, and you throw away the KV state for the entire
conversation to save a few hundred tokens. On a 60k-token session that trade is
enormously negative.

So FE!N enforces a timing rule: digestion happens on the **ingest path**, before
the think model's next render. `MainLens` tracks which events it has already rendered
and refuses to substitute a digest for a frozen event. A late digest is simply
inert — the raw output stays. **Brevity never wins over prefix stability.**

There is a corollary that is easy to miss: this means the observe model is on the
critical path for latency. You cannot digest lazily or in the background and
patch it in later. If the local model is slow, the whole turn is slow. This is
the real cost of the design, and it is why `keep_alive` on the local runtime
matters so much (§5).

### Rule 2c — A delegated stage must fit the model doing it

The observe model exists to save tokens, so it must not be the thing that spends
them. Two limits follow, and both were violated before they were written down:

**The input must fit the delegate's context window.** Sending a 200k result to
a 32k model does not fail cleanly — it fails, falls back, and sends 200k to the
expensive model instead. The window is the budget; oversized input is chunked.

**The delegation must be cheaper than not delegating.** That comparison is
against whatever the *floor* already gives you, not against doing nothing. Once
spill bounds an oversized result for free, the digest is competing with an 8KB
preview, and several cloud calls do not clear that bar. A local observe model does,
because its marginal cost is wall-clock rather than money.

Generalised: **check what the cheap mechanism already achieved before paying
for the expensive one.** Layered fallbacks make the expensive layer's job
smaller, and its justification correspondingly harder.

### Rule 3 — Never slide the window; open an epoch

The standard context-management move is a sliding window: when you approach the
limit, drop the oldest messages.

For a cached prompt this is quietly catastrophic. Dropping message 3 shifts
every token after it, so the cache misses on **every subsequent turn**, forever.
You pay full input price for the rest of the session in exchange for context you
were going to lose anyway. The cost is not a one-time hit; it is a permanent
change in your per-turn price.

FE!N compacts via an **epoch** instead: summarize everything once, restart the
rendered history from that snapshot, and run cache-hot again for many turns.

```
sliding window:  [ miss ][ miss ][ miss ][ miss ][ miss ]  ← forever
epoch:           [ MISS ][ hit  ][ hit  ][ hit  ][ hit  ]  ← amortized
```

Rare-and-expensive beats constant-and-cheap-looking. The epoch also gets to be
*better* compaction than a window, because it can be goal-directed rather than
merely recency-ordered.

### Rule 4 — The front of the prompt is frozen; changes go on the *end*

The system prompt and tool block sit at the very front of every request, so
editing either invalidates 100% of the cache. But "frozen" does not have to mean
"static" — for both, there is an append-shaped alternative that costs nothing.

**Tools.** `ToolRegistry.freeze()` makes mid-session registration throw:

```
tool registry is frozen: registering "search" mid-run would invalidate the
prompt cache. Declare it before the first turn — with deferLoading: true if it
should only become visible later — then surface it with agent.surfaceTool().
```

Dynamic tool sets are a natural and appealing feature — MCP servers connecting
mid-session, plugins loading lazily — and done naively they are a cache
catastrophe. The fix is `deferLoading`: declare the tool in the tool block from
turn one, but keep it out of the model's context. Surfacing it later appends a
`tool_addition` block on a system-role message, extending the prefix rather than
rewriting its front:

```ts
tools.registerDeferred(searchTool);   // in the block from turn one, invisible
// ...later, when the MCP server connects:
agent.surfaceTool("search");          // appends; cache intact
```

`revokeTool()` withdraws one the same way. On providers without the primitive,
FE!N degrades to a plain system message describing the change — the model still
learns the tool set moved, even where it cannot be enforced structurally.

**System prompt.** Same shape. **Never interpolate anything that varies per
turn** — no timestamps, no step counters, no "you have used 3 of 10 tool calls."
Each makes your hit rate exactly zero, and all are extremely common. For context
the app learns mid-session, `agent.injectContext()` appends a **system-role
message** instead of editing the prompt. That is cache-free, and it is also the
non-spoofable channel: text smuggled into a user turn can be forged by anything
that writes to user-visible input; a system-role message cannot.

If you genuinely must change the front of the prompt, take an epoch (Rule 3) and
pay for it deliberately.

### Rule 5 — Harness-internal work never touches the main channel

Every delegated inference — a digest attempt, a verdict from the verify model —
goes to a **side channel**. The think model's transcript sees only outcomes.

This is partly context hygiene: the think model should not read the harness talking
to itself. But it is also an append-only-ness argument — the main channel must
grow only with settled facts, so that its render is stable. Side channels are
fully retained for auditing, so nothing is hidden; it is filed elsewhere.

This is why a rejected digest (one that came back no smaller than the original)
costs nothing structurally. It happened, it is recorded, and the main channel
never learns of it.

### Rule 6 — Concurrency must not be observable in the record

When the think model issues three tool calls and we execute them concurrently, they
finish in nondeterministic order. If results are appended in *completion* order,
the transcript depends on machine timing — replay the same session twice and you
get different prefixes, and cache lookups miss for reasons nobody can reproduce.

FE!N executes concurrently but **appends in call order, always**. Concurrency is
a latency optimization; it must not be visible in the transcript.

Relatedly: read-only calls run in parallel, side-effecting calls run serially and
in order. Two parallel writes to the same path have an undefined winner, and the
concurrency win is almost entirely in the read path anyway.

### Rule 7 — Anchor placement fights two constraints at once (Anthropic)

Anthropic gives you up to 4 explicit `cache_control` breakpoints. Placing them
means satisfying two requirements that pull against each other.

**Stability.** An anchor must land on settled history. FE!N places the primary
message anchor on the **second-to-last** message, not the last: anchoring the
moving edge writes a fresh entry every turn (at 1.25x) and reads almost nothing.
One message back, the anchor lands on history the next turn reads *through*.

**Reach.** This is the one that quietly ruins otherwise-correct harnesses. A
breakpoint searches backward **at most 20 content blocks** for a prior entry.
Blocks, not messages — and an agentic turn is block-dense:

```
assistant: 1 text + 6 tool_use   =  7 blocks
user:      6 tool_result         =  6 blocks
                                   ── 13 blocks for ONE turn
```

Two such turns and the previous anchor is 26 blocks back — out of reach. The
breakpoint finds nothing, you pay full price for the entire conversation, and
there is no error, no warning, and nothing in the response that says why. A
harness that batches parallel tool calls — which FE!N does, deliberately, for
latency — walks straight into this.

So FE!N spends the breakpoint budget left over after system and tools by walking
backward from the settled edge and dropping an additional anchor whenever the
running block count approaches the limit. Anchors are chosen by *block position*
rather than message count, which keeps the placement a deterministic function of
the transcript prefix — and therefore itself cache-safe.

### Rule 8 — Concurrent identical requests all miss

A cache entry becomes readable only once the first response *begins streaming*.
Fire N requests with the same prefix simultaneously and all N pay full price:
none can read what the others are still writing.

This is a live concern for hybrid delegation, where fanning out local work in
parallel is the whole latency argument. It costs nothing when the parallel calls
go to *different* models (separate caches anyway), which is the common case
here. When they share a prefix, send one, await first token, then fan out.

### Rule 9 — Each binding has its own cache lineage

A local model and a cloud model do not share a tokenizer, a KV cache, or an
attention geometry. There is no such thing as handing warm state from one to the
other. Cross-model alignment happens at the **event** level (messages), never at
the token level.

This is why the IR is message-shaped rather than token-shaped, and it is a hard
constraint, not a design preference. Any scheme that involves "the local model
pre-computes something the cloud model can reuse" at the tensor level is
impossible across vendors. What *can* transfer is information: a digest, an
argument, a verdict.

### Rule 10 — Cache TTL expires during human thinking time

This one does not show up in benchmarks at all, because benchmarks do not pause
to get coffee.

Anthropic's default ephemeral cache lives ~5 minutes, refreshed on each read. A
real interactive session is not paced in seconds: the user reads the output,
thinks, context-switches, and types a follow-up eight minutes later. The prefix
is byte-identical, the harness did everything right, and the request still
misses — the entry simply expired. On a 60k-token prefix at $3/Mtok,
re-establishing costs ~$0.18.

**The first answer is the 1-hour TTL, not a heartbeat.** `cacheTtl: "1h"` costs
2x to write instead of 1.25x, moving break-even from two requests to three — and
in exchange it needs no timers, no background traffic, and no spending while the
user is away. For an interactive session with human-scale gaps, that is usually
the better trade, and it is what to reach for first.

`CacheKeeper` is the fallback for when the write premium genuinely does not pay
off — short sessions, or prefixes read only a couple of times. It fires a
`max_tokens: 0` request every 4 minutes, which runs prefill and refreshes the
entry while billing zero output tokens. (The older `max_tokens: 1` trick billed
a token and returned a reply to discard; `0` supersedes it.)

The honest caveats, which are in the code comments too:

- Every heartbeat is a real billed call — the cache read, at 0.1x. This trades
  a small certain cost against a larger probable one. It is a **bet**, so it is
  off by default.
- If the user walks away for an hour it is pure waste; hence `maxRefreshes`
  bounds the loss.
- Heartbeats appear in the ledger. A harness that spends money on your behalf
  while you are not looking must at minimum tell you it did.
- `max_tokens: 0` is rejected alongside streaming, enabled thinking, forced
  `tool_choice`, and structured output formats — so the heartbeat request is
  built minimally rather than cloned from the real one.

---

## 3. Trust tiers: cheap where it is safe, expensive where it is not

Letting an agent near a shell requires an asymmetry argument:

> Reading the wrong file wastes a few hundred tokens.
> Writing the wrong file, or running the wrong command, is unrecoverable.

But *whose* mistake is it? That question is what tiers the trust:

- A call the **think model** makes executes as-is. The think model is acting on the user's
  own instruction and is the authority. Second-guessing it with another model
  would be a tax on every turn to catch a rare failure.
- A call a **subagent** makes is an agent acting on a task string that *another
  model* wrote — no human approved those exact words. That is where a drifting
  instruction compounds silently instead of surfacing: the parent asked for one
  thing, the task string drifted, and the subagent faithfully executes the
  drift. So at depth > 0, side-effecting calls go past the `verify` model first.
- **Read-only** calls run unverified at every depth. Bounded downside, and speed
  was the point.
- If **no verify model is bound**, a subagent's side-effecting call is *refused*.
  Fail closed. A missing safety component must not silently become no safety
  component.

Two mechanisms cover safety here and they are not interchangeable. **Hooks** are
the rule-shaped half: deterministic policy that needs no judgment and should not
pay for a model round trip ("never run `rm -rf`"). The **verify model** is the
model-shaped half, for the question no rule can express: *does this call still
resemble what was asked?*

`verify` is itself a slot, so you choose the paranoia level. Because it only
fires on subagent mutations — rare — binding it to the expensive model costs
almost nothing.

An unparseable verdict is treated as a denial. Ambiguous safety signals are not
permission.

---

## 4. What the ledger is for

Both of FE!N's central claims are empirical, so the harness measures them:

```
calls 4  ·  $0.0118  ·  0.2s
  local    1 calls  3.4k in / 43 out  $0.0000
  cloud    3 calls  3.9k in / 79 out  $0.0118
  cache  hit 5.8%  read 419 / fresh 6.9k  saved $0.0011
  offload  ~$0.0108 of cloud spend served locally
  think         3x    $0.0118  (0 local / 3 cloud)
  observe       1x    $0.0000  (1 local / 0 cloud)
```

Note the 5.8% hit rate in that three-turn demo. It is low, and it is shown
anyway. Cache hit rate rises with session length — the whole benefit is
amortization — and a harness that only displayed flattering numbers would be
useless for the thing you actually want it for, which is deciding whether any
of this is worth it for *your* workload.

`offload` is explicitly labeled an estimate. Token counts differ across
tokenizers, so a cross-model dollar comparison is directionally useful and not
a bill.

Every prefix break is recorded with the slot that caused it. That turns "why is
this session expensive" into a question with an answer.

---

## 5. Local-side details that are easy to underestimate

**Keep the model resident.** Ollama's `keep_alive` (defaulted to 30m in
`OllamaPort`) keeps weights loaded between calls. Cold-loading a 3B model costs
more wall-clock than every delegation it will serve in a session. A hybrid
harness that lets the local model unload between turns will feel slower than
pure cloud and the user will conclude local models are useless.

**Prefix stability helps locally too.** llama.cpp and vLLM do prefix reuse. The
discipline in §2 is provider-agnostic: a stable prefix is the difference between
a 200ms delegation and a 4s one on a small model.

**Small models want JSON, not native tool calling.** Native tool-calling APIs on
small models are markedly less reliable than plain JSON emission, and JSON keeps
the prompt identical across providers. `parseJsonToolCalls` accepts the shapes
they actually emit — fenced blocks, prose-wrapped objects,
`args`/`arguments`/`parameters` — because the premise of delegating to a 3B
model is that the *harness* absorbs its sloppiness. This matters whenever a
local model drives (the local-only profile), even though no slot now asks a
small model to construct a call.

**The local context window is the binding constraint on digestion.** A 32k local
model cannot digest a 200k tool result. Chunked digestion is not yet
implemented; see §7.

---

## 6. Prior art and what FE!N takes from it

A detailed side-by-side against four open-source harnesses — what we adopted,
what we declined and why, and what survived contact unchanged — is in
[COMPARISON.md](./COMPARISON.md).

- **DeepSeek's harness** — models as swappable plugins behind one interface.
  FE!N extends this from "swap the model" to "swap the model *per stage*."
- **Pi / Hermes** — the loop as an explicit, inspectable state machine rather
  than an opaque `while` loop around one chat call.
- **nanobot** — minimal core, capability by composition. FE!N's core is the
  transcript plus the lens; everything else is a plugin.

The novel claim is narrow and specific: **the loop stages are independently
bindable, and the harness maintains cache-safety across a heterogeneous set of
models.** The second half is the hard part, and it is the reason §2 is the
longest section in this document.

---

## 7. Open problems — the honest list

Things that are unsolved, partially solved, or where the design might be wrong.

**Chunked digestion — done, and it changed the economics.** A 32k local model
cannot digest a 200k result in one pass. Before, the whole thing went to
whatever model was bound: the local call failed, the router fell back, and 200k
tokens went to the *cloud* — spending real money to save tokens, the exact
inverse of the point. Measured: 217k tokens sent to a 32k-window model.

Digestion is now windowed and chunked, with the anomaly-preservation risk
handled by splitting the prompts: each chunk is told it is seeing a fragment and
must not guess at context, and the merge is told its job is to *join, not
summarize again* — which is where a second pass would otherwise smooth away the
single anomalous line the first pass correctly kept.

The interesting part is the chunk cap, which is **locality-dependent**:

```
local  → 16 chunks   marginal cost is wall-clock on hardware you already own
cloud  →  1 chunk    a result needing more is declined outright
```

A cloud observe model facing a result too large for one call now **refuses**. That
looks strange until you notice spill: an oversized result is *already* bounded
to a few KB for free, losslessly, with a retrieval path. So chunked cloud
digestion is not competing against 200k raw tokens — it is competing against an
8KB preview that cost nothing, and its marginal benefit is the difference
between a preview and a summary. Measured at ~$0.24 for four chunks, that needs
dozens of turns to repay and the session usually ends first.

This is the clearest case in the codebase where **the same operation is
obviously worth it locally and obviously not worth it in the cloud** — the
hybrid argument compressed into one constant. It only became visible once spill
and digestion both existed; each alone looks fine.

**Digest quality is unmeasured.** We know digests are *smaller*. We do not
systematically know whether they preserve the decision-relevant facts. The right
instrument is a task-level A/B (same task, observe model on vs off, compare success
rate), not a summarization benchmark. Until that exists, the observe model's value is
argued rather than demonstrated, and errors are excluded from digestion as a
blunt hedge.

**Speculative delegation is tempting and unproven.** While the cloud think model is
generating, the local model could speculatively execute the most likely next
tool call. If it guesses right you hide the entire tool latency. If it guesses
wrong you have run a tool nobody asked for — fine for reads, unacceptable for
writes, and it pollutes the transcript with speculation that must be discarded
without breaking the prefix. Deliberately not built.

**Routing is static by default; adaptive routing is opt-in and bounded.** A
binding may carry a `RoutePolicy` (models/policy.ts): the loop reports facts
("the guard fired twice", "this digest was rejected", "this request is ~600
tokens") and the policy — a pure function of those facts — picks a port and a
thinking level from the binding's declared chain. Three policies ship:
escalate-on-stuck (guard fires → same port, higher thinking effort; never a
port swap, because prompt caches are keyed per model and opaque reasoning
blocks do not replay across models), escalate-on-reject (a digest that fails
the 70% quality gate gets one retry on a stronger port — the observe slot's
calls carry a fresh context, so the swap has no cache stake), and right-size
(trivially small side-slot requests go to the small model). The §2 Rule 6
tension resolves because every input to a decision is derivable from the
recorded transcript, and every decision is logged (`route` trace event, ledger
escalation counts). What remains open: a policy that learns per-tool ("stop
digesting tool X") — the hints plumbing makes it a small follow-up — and any
policy driven by latency or error rates, which is inherently nondeterministic
and stays excluded on purpose. Swapping the *think* port at an epoch boundary
(compaction restarts from plain text, so nothing would break) is designed but
not built. What IS built at the other safe boundary: plan-execute delegation —
bind the `execute` slot and the spawn tool grows a per-step `tier` choice the
think model fills, an `acceptance` field that forces the plan to say what
"done" means, and code-enforced fail-fast for light-tier children (first guard
fire → report the blockage; the planner replans, the harness never re-routes
on its own).

**Two clocks.** Local models have low, stable latency; cloud models have higher,
spikier latency. A turn that delegates three times serially can be *slower* than
one cloud round-trip even while being cheaper. FE!N parallelizes reads, but
there is no cost/latency policy — no way to say "prefer speed under $X."

**Epoch boundaries are heuristic.** We compact at 75% of the think model's window.
The genuinely right moment is task-structural: compact when a subtask completes,
because that is when the detail becomes safely discardable. That requires the
think model to signal task boundaries, which requires prompting it to, which costs
tokens on every turn to save tokens occasionally.

Persistence softens this considerably — an epoch now forks a child session and
the parent keeps everything, so a badly-timed compaction loses *context*, not
*data*, and `session_lineage` lets the model go back for what the summary
dropped. But a badly-timed compaction still costs a turn's worth of confusion,
and the model has to notice it needs to look.

**Recall is keyword-only.** FTS5 finds "postgres ledger" but not "which database
did we pick". Semantic recall needs an embedding model, which in a hybrid harness
should obviously be the *local* one — that is a natural sixth slot (`embedder`)
and it is not built.

**Skills are written but never revised.** `write_skill` appends to the library;
nothing prunes it, merges near-duplicates, or notices when a skill has gone
stale against the code it describes. A library that only grows eventually
becomes an index the model skims past.

**Hook scripts are unsandboxed.** A `beforeTool` hook runs with the user's full
privileges — which is correct for a mechanism whose job is enforcing policy, and
also means a malicious `.fein/hooks/` directory is a malicious executable
directory. Cloning a repo with hooks in it is equivalent to running its build
scripts. That is the same trust model as `.git/hooks`, stated rather than
implied.

**Subagent caps are now per-run.** `maxSpawns` bounds one agent's fan-out,
which sounds like a cap and is not one: growth is breadth^depth, so a limit of
3 at depth 3 measured **40 agents** — every agent obeyed its own limit and the
tree still exploded.

`SpawnBudget` is one allowance created at the root and shared *by reference*
down the whole tree, so the hundredth agent is refused no matter which branch
asked. The sharing is the load-bearing part: an early version passed the budget
by value and each subtree quietly built its own, turning a run-level cap into a
per-subtree cap — the same explosion wearing a limit.

**The scheduler is a foreground process.** `fein cron serve` runs until you
Ctrl-C it. There is no daemon, no launchd/systemd integration, and no locking
between two `serve` processes on the same jobs database — the second one would
happily fire the same jobs.

**Cross-provider cache portability does not exist.** If you fail over from
Anthropic to OpenAI mid-session, the new provider's cache is cold and you pay
full price for the entire history. Fallback is correct for availability and
expensive for cost, and the ledger will show it as a cliff. There is no fix —
this is a property of the market, not of the harness.

**Token estimation is crude — but no longer load-bearing for compaction.**
`estimateTokens` is `length / 4`. It used to drive the compaction threshold,
where being 30% low means blowing the context window and 30% high means paying
for a summary you did not need. The provider reports the true prompt size on
every response, so we now anchor on that and use the heuristic only until the
first real answer arrives.

It still drives digestion thresholds, and it still means FE!N cannot *enforce*
the minimum-cacheable-prefix rule (§2): deciding "this prefix is too short to be
worth a breakpoint" needs a real count, and being wrong optimistically means
paying the 1.25x write premium for an entry that was never created. Today we
place the anchors and let the ledger show whether they took.

**Deferred tools solve the cache problem, not the discovery problem.** A tool
must still be *known* at construction time to be declared deferred. A genuinely
unknown tool — an MCP server whose schema the harness has never seen — still
requires an epoch. Provider-side tool search is the real answer there and is not
integrated.

**Cross-provider degradation of mid-conversation changes is lossy.** On
Anthropic, a surfaced tool is a structural `tool_addition`. Everywhere else it
degrades to a sentence of prose ("The tool `x` is now available"), which the
model may ignore, and which does not actually stop it calling a revoked tool. The
harness still refuses the call at execution time, so this is a
context-quality gap rather than a safety one — but the two providers are not
equivalent, and a benchmark run across both would not be comparing like with
like.
