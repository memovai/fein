import type { Tool } from "../tools/registry.js";
import { ToolRegistry } from "../tools/registry.js";
import type { Router } from "../models/router.js";
import type { Ledger } from "../telemetry/ledger.js";
import type { StepName } from "../core/types.js";

/**
 * Subagent delegation.
 *
 * Distinct from FE!N's *slot* delegation, and the distinction matters:
 *
 *  - **Slot delegation** hands one stage of one turn to a different model —
 *    the digester compressing an observation. Same conversation, same
 *    transcript, no new context, and the driver keeps every decision.
 *  - **Subagent delegation** hands an entire sub-task to a fresh agent with
 *    its own context window, which reports back a summary. The parent gives up
 *    every intermediate decision in exchange for never seeing the intermediate
 *    material.
 *
 * The choice between them is a question about *control*, not about cost:
 * delegate to a subagent when you do not need to steer mid-task, and to a slot
 * when you must keep the decision but the data is bulky. See DESIGN.md §1,
 * "Choosing a delegation boundary".
 *
 * They compose: a subagent is itself a full FE!N agent, so it can run its own
 * hybrid loop — a cheap local driver for a mechanical sub-task, a frontier
 * driver for a hard one — and its cost lands in the same ledger.
 *
 * ## Why the depth cap is not optional
 *
 * A subagent that can spawn subagents is a recursive process whose base case
 * is decided by a language model. That is not a base case. Without a hard cap
 * the failure mode is not a crash but a bill: an exponential fan-out where
 * each level looks locally reasonable. So depth is tracked explicitly, the cap
 * is enforced in code rather than in a prompt, and a subagent at the cap
 * simply does not receive the spawn tool — it cannot attempt what it is not
 * permitted to do, which is more reliable than telling it not to.
 *
 * The breadth cap exists for the same reason at a different axis: ten parallel
 * subagents from one turn is ten context windows and ten times the spend, and
 * the decision to do that should be the harness's, not an enthusiastic model's.
 */

/**
 * A spawn allowance shared by every agent in one run.
 *
 * `maxSpawns` bounds what a *single* agent may spawn, which sounds like a cap
 * and is not one: with a breadth of 3 and a depth of 3 it permits 40 agents,
 * because the growth is breadth^depth rather than breadth × depth. Every
 * individual agent obeyed its limit; the tree still exploded.
 *
 * This is the cap that actually caps. One object, created at the root and
 * shared by reference down the whole tree, so the hundredth agent is refused
 * no matter which branch asked for it.
 */
export class SpawnBudget {
  private remaining: number;

  constructor(total: number) {
    this.remaining = Math.max(0, total);
  }

  /** Claim one spawn. False when the run has none left. */
  take(): boolean {
    if (this.remaining <= 0) return false;
    this.remaining--;
    return true;
  }

  get left(): number {
    return this.remaining;
  }
}

export interface SubagentOptions {
  /** Max nesting depth. 1 = the driver may spawn, but its children may not. */
  maxDepth?: number;
  /** Max subagents a single agent may spawn over its whole run. */
  maxSpawns?: number;
  /** Steps a subagent may take before it must report back. */
  maxSteps?: number;
  /**
   * Total subagents allowed across the entire run, at every depth.
   *
   * The one that bounds cost. `maxSpawns` limits a single agent's fan-out;
   * this limits the tree.
   */
  maxTotalSpawns?: number;
  /** Which slot the subagent's driver binds to. Defaults to the parent's. */
  driverSlot?: StepName;
}

export const DEFAULT_SUBAGENT_OPTIONS: Required<Omit<SubagentOptions, "driverSlot">> = {
  maxDepth: 2,
  maxSpawns: 8,
  maxSteps: 12,
  maxTotalSpawns: 16,
};

export interface SubagentDeps {
  router: Router;
  ledger: Ledger;
  tools: ToolRegistry;
  cwd: string;
  depth: number;
  allowSideEffects: boolean;
  options?: SubagentOptions;
  /** Shared across the run. The cap that actually caps. */
  budget: SpawnBudget;
  /** Injected to avoid a circular import with the Agent class. */
  spawn: (args: {
    task: string;
    router: Router;
    tools: ToolRegistry;
    ledger: Ledger;
    cwd: string;
    depth: number;
    maxSteps: number;
    allowSideEffects: boolean;
  }) => Promise<{ text: string; steps: number }>;
}

/**
 * Build the `spawn_subagent` tool — or return nothing, if this agent is at the
 * depth cap. Returning nothing rather than a tool that always refuses is
 * deliberate: an unavailable capability costs zero tokens and cannot be
 * argued with, while a refusing tool invites retries.
 */
export function subagentTool(deps: SubagentDeps): Tool | undefined {
  const opts = { ...DEFAULT_SUBAGENT_OPTIONS, ...deps.options };
  if (deps.depth >= opts.maxDepth) return undefined;

  let spawned = 0;

  return {
    spec: {
      name: "spawn_subagent",
      description:
        "Delegate a self-contained sub-task to a fresh agent with its own context window, and " +
        "get back a summary of what it found or did. Worth it when the sub-task would flood " +
        "your context with material you do not need afterwards (reading many files, sweeping a " +
        "large search space) or when several independent tracks can run separately. Not worth " +
        "it for work you could finish in a few tool calls yourself — each spawn re-establishes " +
        "context from nothing. The subagent cannot see this conversation, so the task must be " +
        "self-contained: include paths, constraints, and what to report.",
      parameters: {
        type: "object",
        properties: {
          task: {
            type: "string",
            description:
              "The complete, self-contained instruction, including what to report back.",
          },
          read_only: {
            type: "string",
            description:
              "\"true\" to forbid the subagent any side effects. Default \"true\". " +
              "Use \"false\" only when the sub-task must modify the workspace.",
          },
        },
        required: ["task"],
      },
    },
    async run(args) {
      if (spawned >= opts.maxSpawns) {
        return (
          `You have spawned ${opts.maxSpawns} subagents, which is your limit. ` +
          `Complete the remaining work directly.`
        );
      }
      // The run-level check comes second so the local message is the one the
      // model sees when its own fan-out is the problem — more actionable than
      // "the run is out of budget" when the run is out of budget because of you.
      if (!deps.budget.take()) {
        return (
          `This run has used its entire subagent budget across all branches. ` +
          `No further delegation is possible at any depth. Complete the remaining work directly.`
        );
      }
      spawned++;

      const task = String(args["task"] ?? "").trim();
      if (!task) return "Refused: empty task. A subagent cannot infer what you want.";

      // Read-only by default. A subagent's instructions come from another
      // model's output, so the blast radius stays bounded unless the caller
      // explicitly widens it — and it can never widen past its own parent.
      const readOnly = String(args["read_only"] ?? "true").toLowerCase() !== "false";
      const allowSideEffects = deps.allowSideEffects && !readOnly;

      // The child gets its own registry so its spawn tool reflects *its* depth.
      const childTools = new ToolRegistry();
      for (const spec of deps.tools.specs()) {
        const t = deps.tools.get(spec.name);
        if (t && spec.name !== "spawn_subagent") childTools.register(t);
      }

      const result = await deps.spawn({
        task,
        router: deps.router,
        tools: childTools,
        ledger: deps.ledger,
        cwd: deps.cwd,
        depth: deps.depth + 1,
        maxSteps: opts.maxSteps,
        allowSideEffects,
      });

      return (
        `Subagent (depth ${deps.depth + 1}, ${result.steps} steps, ` +
        `${allowSideEffects ? "read-write" : "read-only"}) reported:\n\n${result.text}`
      );
    },
  };
}
