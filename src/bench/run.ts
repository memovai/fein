#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Agent } from "../core/loop.js";
import { defaultTools } from "../tools/builtin.js";
import { TASKS, type BenchTask } from "./tasks.js";
import { CONFIGS, realPorts, scriptedPorts, type BenchConfig, type BenchPorts } from "./configs.js";
import { report, type Row } from "./report.js";

/**
 * The benchmark driver.
 *
 * It exists because FE!N makes two empirical claims — delegation saves money,
 * the cache stays hot — and a harness that cannot check its own claims is
 * asking to be believed. The toolformer is the cautionary tale: it survived
 * for as long as it did because it was argued for rather than measured.
 *
 * Two modes, and the difference is not cosmetic:
 *
 *   --scripted  Deterministic, free, CI-able. Measures **mechanism overhead**
 *               exactly. `success` is meaningless here — the scripted driver
 *               always finds the answer — so the report suppresses it.
 *   (default)   Real models. The only mode that can answer the question that
 *               actually matters: is the compressed observation still good
 *               enough to get the right answer?
 */

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(here, "fixtures");

async function runOne(
  task: BenchTask,
  config: BenchConfig,
  makePorts: () => BenchPorts,
  scripted: boolean,
): Promise<Row> {
  // Fresh ports per run. ScriptedPort carries per-instance state (a turn
  // counter, a cache-simulation prefix), so sharing one instance across the
  // matrix silently contaminates every row after the first.
  const { router, subagents } = config.build(makePorts());
  const started = Date.now();

  const agent = new Agent({
    router,
    tools: defaultTools(),
    cwd: FIXTURES,
    subagents,
    maxSteps: 10,
    // Read-only: a benchmark that can mutate its own fixtures is not a
    // benchmark, it is a source of confusing reruns.
    allowSideEffects: false,
  });

  let answer = "";
  let error: string | undefined;
  try {
    answer = (await agent.run(task.prompt)).text;
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  const s = agent.ledger.summary({ in: 3, out: 15 });
  const failure = error ?? (scripted ? undefined : task.check(answer));

  return {
    task: task.id,
    config: config.id,
    ok: failure === undefined,
    ...(failure ? { failure } : {}),
    cloudIn: s.byLocality.cloud.inTok,
    cloudOut: s.byLocality.cloud.outTok,
    localIn: s.byLocality.local.inTok,
    localOut: s.byLocality.local.outTok,
    usd: s.totalUsd,
    ms: Date.now() - started,
    cacheHitRate: s.cache.hitRate,
    prefixBreaks: s.cache.breaks.length,
    calls: s.calls,
  };
}

async function main(): Promise<void> {
  const scripted = process.argv.includes("--scripted");
  const only = argValue("--task");
  const tasks = only ? TASKS.filter((t) => t.id === only) : TASKS;
  if (tasks.length === 0) {
    console.error(`no such task: ${only}. Known: ${TASKS.map((t) => t.id).join(", ")}`);
    process.exit(2);
  }

  let makePorts: () => BenchPorts;
  if (scripted) {
    const log = await readFile(join(FIXTURES, "test/run.log"), "utf8");
    makePorts = () => scriptedPorts(log);
  } else {
    const apiKey = process.env["ANTHROPIC_API_KEY"];
    if (!apiKey) {
      console.error(
        "ANTHROPIC_API_KEY is not set.\n" +
          "Run the free, deterministic version instead:  node dist/bench/run.js --scripted\n" +
          "That measures mechanism overhead; only the real run can tell you whether the\n" +
          "cheap path is good enough.",
      );
      process.exit(2);
    }
    // Real ports are stateless and hold connections; build once.
    const shared = realPorts({
      cloudModel: process.env["FEIN_CLOUD_MODEL"] ?? "claude-sonnet-5",
      localModel: process.env["FEIN_LOCAL_MODEL"] ?? "qwen2.5:3b",
      apiKey,
    });
    makePorts = () => shared;
  }

  const rows: Row[] = [];
  for (const task of tasks) {
    for (const config of CONFIGS) {
      // local-only against scripted ports is meaningless — the scripted "local"
      // model only knows how to digest, not to drive.
      if (scripted && config.id === "local-only") continue;
      process.stderr.write(`  ${task.id} × ${config.id}\n`);
      rows.push(await runOne(task, config, makePorts, scripted));
    }
  }

  process.stdout.write(report(rows, { scripted, tasks }));

  // A wrong answer is a failure, not a footnote — exit non-zero so this can
  // gate CI without anyone having to read the table.
  const failures = rows.filter((r) => !r.ok);
  if (failures.length > 0 && !scripted) process.exit(1);
}

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack : String(err));
  process.exit(1);
});
