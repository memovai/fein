import type { Router } from "../models/router.js";
import type { Ledger } from "../telemetry/ledger.js";
import type { Transcript } from "../core/transcript.js";
import { VERIFIER_SYSTEM } from "./prompts.js";
import type { ToolCall, ToolSpec } from "../core/types.js";

export interface Verdict {
  allow: boolean;
  reason: string;
  servedBy: string;
}

/**
 * The verifier gates world-changing calls made by a **subagent**.
 *
 * The asymmetry it exists for:
 *
 *   A call the driver makes is the driver acting on the user's instruction.
 *   A call a subagent makes is an agent acting on a task string that *another
 *   model* wrote. No human ever approved those exact words.
 *
 * That second case is where a model's mistake compounds instead of surfacing:
 * the parent asked for one thing, the task string drifted, and the subagent
 * faithfully executes the drift. Reading the wrong file there wastes tokens;
 * writing the wrong file is unrecoverable. So side-effecting calls at depth > 0
 * are checked against the task the subagent was actually given, and read-only
 * calls run unverified because the downside is bounded.
 *
 * This is the model-shaped half of the safety story. Hooks are the rule-shaped
 * half: deterministic policy that does not need a model's judgment and should
 * not pay for one. Use hooks for "never run rm -rf"; use this for "does this
 * call still resemble what was asked".
 *
 * Deliberately bindable to any model. Bind it to the cloud driver for a
 * careful gate — it only fires on subagent mutations, so it is rare and its
 * cost is negligible. Bind nothing and subagent mutations run ungated, which
 * is why the loop only consults it when a verifier is actually bound.
 *
 * An unparseable verdict is a denial. Ambiguous safety signals are not
 * permission.
 */
export async function verify(args: {
  router: Router;
  ledger: Ledger;
  transcript: Transcript;
  call: ToolCall;
  spec: ToolSpec;
  intent: string;
  signal?: AbortSignal;
}): Promise<Verdict> {
  if (!args.router.has("verifier")) {
    return {
      allow: false,
      reason:
        "a subagent proposed a side-effecting call but no verifier is bound; " +
        "refusing to execute unchecked",
      servedBy: "harness",
    };
  }

  const channel = args.transcript.newSideChannel("verify");
  const { result, port } = await args.router.run(
    "verifier",
    {
      system: VERIFIER_SYSTEM,
      messages: [
        {
          role: "user",
          content: [
            `Task this agent was given:`,
            args.intent,
            ``,
            `Tool it wants to call: ${args.call.name}`,
            `Arguments: ${JSON.stringify(args.call.args, null, 2)}`,
            ``,
            `Tool description: ${args.spec.description}`,
          ].join("\n"),
        },
      ],
      maxTokens: 200,
      temperature: 0,
    },
    args.signal,
  );
  args.ledger.record("verifier", port.info, result);
  args.transcript.assistant(result.text, [], `verifier@${port.info.id}`, channel);

  const parsed = extractVerdict(result.text);
  return { ...parsed, servedBy: port.info.id };
}

function extractVerdict(text: string): { allow: boolean; reason: string } {
  const a = text.indexOf("{");
  const b = text.lastIndexOf("}");
  if (a >= 0 && b > a) {
    try {
      const obj = JSON.parse(text.slice(a, b + 1)) as { verdict?: string; reason?: string };
      if (obj.verdict === "allow") return { allow: true, reason: obj.reason ?? "allowed" };
      if (obj.verdict === "deny") return { allow: false, reason: obj.reason ?? "denied" };
    } catch {
      /* fall through */
    }
  }
  // Unparseable verdict fails closed. An ambiguous safety signal is a denial.
  return { allow: false, reason: `verifier returned an unparseable verdict: ${text.slice(0, 160)}` };
}
