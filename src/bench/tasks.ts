/**
 * Benchmark tasks.
 *
 * Every task has a **mechanically checkable** answer. That constraint is the
 * whole design: a benchmark scored by an LLM judge measures the judge as much
 * as the harness, and the question here — "does compressing the observation
 * change the outcome?" — is exactly the kind a judge would paper over.
 *
 * The tasks are chosen to exercise the three mechanisms differently:
 *
 *  - `find-symbol` and `list-importers` are **search-shaped**: the work is
 *    reading many files to extract a little. That is a subagent's case.
 *  - `failing-test` is **observation-shaped**: one command the think model must
 *    choose, whose output is 3000 tokens with one line that matters. That is
 *    the observe model's case, and the one where a lossy digest would silently
 *    produce a wrong answer.
 *  - `dep-version` is a **control**: small input, small output, no mechanism
 *    should help. If a configuration is slower or pricier here, that is its
 *    fixed overhead showing.
 */

export interface BenchTask {
  id: string;
  prompt: string;
  /** Returns undefined on success, or a description of what was wrong. */
  check(answer: string): string | undefined;
  /** What this task is meant to discriminate between. */
  exercises: string;
}

const has = (answer: string, needle: string): boolean =>
  answer.toLowerCase().includes(needle.toLowerCase());

export const TASKS: BenchTask[] = [
  {
    id: "find-symbol",
    exercises: "search — many files read, little extracted (subagent's case)",
    prompt:
      "Which file defines the function `parseConfig`? Answer with the file path and nothing else.",
    check: (a) => (has(a, "src/config.ts") ? undefined : `expected src/config.ts, got: ${trim(a)}`),
  },
  {
    id: "failing-test",
    exercises: "observation — 3k-token log, one line matters (observe model's case)",
    prompt:
      "Read test/run.log. Exactly one test fails. Report how many tests failed, the name of the " +
      "failing test, and the source location it points at.",
    check: (a) => {
      const problems: string[] = [];
      if (!/\b1\b|\bone\b/i.test(a)) problems.push("did not report exactly 1 failure");
      if (!has(a, "trailing comma")) problems.push("did not name the failing test");
      if (!has(a, "parser.ts")) problems.push("did not report the source location");
      return problems.length ? `${problems.join("; ")} — got: ${trim(a)}` : undefined;
    },
  },
  {
    id: "list-importers",
    exercises: "search — set-valued answer, easy to under-report",
    prompt:
      "Which files under src/ import lodash? List every one. Answer with paths only.",
    check: (a) => {
      const want = ["config.ts", "parser.ts"];
      const missing = want.filter((w) => !has(a, w));
      const spurious = ["util.ts", "server.ts"].filter((w) => has(a, w));
      const problems: string[] = [];
      if (missing.length) problems.push(`missed ${missing.join(", ")}`);
      if (spurious.length) problems.push(`wrongly included ${spurious.join(", ")}`);
      return problems.length ? `${problems.join("; ")} — got: ${trim(a)}` : undefined;
    },
  },
  {
    id: "dep-version",
    exercises: "control — no mechanism should help; overhead shows here",
    prompt:
      "What exact version of the `typescript` devDependency is in package.json? Answer with the " +
      "version string and nothing else.",
    check: (a) => (has(a, "5.7.2") ? undefined : `expected 5.7.2, got: ${trim(a)}`),
  },
];

function trim(s: string): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > 120 ? `${one.slice(0, 117)}...` : one;
}
