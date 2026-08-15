import type { Reasoning, ToolCall, ToolSpec } from "../core/types.js";

/**
 * The ReAct dialect: Thought → Action → Observation, in plain text.
 *
 * ## Why this exists at all
 *
 * FE!N's thesis is that any model can fill any slot. In practice that was only
 * half true: a small local model could *assist* (digest, compress) but could not
 * *drive*, because driving meant native tool calling and small models are bad at
 * it — they omit required fields, invent parameter names, emit a tool call and
 * then keep talking, or lose the schema entirely by step four. The `local-only`
 * profile existed on paper and fell over in practice.
 *
 * ReAct is the fix, and it is not a downgrade. The format is in every model's
 * training data, it degrades gracefully (a malformed Action is a parse error we
 * can correct, not a silent wrong call), and it makes the reasoning legible
 * instead of hidden inside a provider's thinking blocks.
 *
 * ## The three failure modes this protocol is shaped around
 *
 * **1. The model hallucinates its own Observation.** Left alone, a model will
 * happily write `Observation: the file contains...` and carry on reasoning
 * about a result no tool ever produced. This is the classic ReAct failure and
 * it is silent — the transcript looks perfect. The fix is mechanical, not
 * prompted: `Observation:` is a **stop sequence**, so generation ends before the
 * model can invent one. Never rely on asking it not to.
 *
 * **2. The model emits an Action and keeps going.** Also handled by the stop
 * sequence, plus the parser taking only the first Action in a response.
 *
 * **3. The model forgets the format.** Small models drift after a few turns. So
 * the parser is forgiving in the direction that is safe (prose around the
 * markers, an inline `Action: tool({...})`, a missing `Action Input`) and strict
 * in the direction that is not: it never guesses a tool name, and an
 * unparseable Action becomes a correction rather than an invented call.
 *
 * ## What "complete" means here
 *
 * The cycle is complete in both directions. Thought is preserved on the
 * assistant event and replayed on the next request, so the model sees its own
 * prior reasoning rather than rediscovering it. Observation is the tool result
 * *after* spill and digest have shaped it — which is exactly where FE!N's
 * existing machinery belongs in the ReAct picture.
 */

/** Ends generation before the model can write its own Observation. */
export const REACT_STOP = ["\nObservation:", "\nObservation :"];

export const FINAL_ANSWER_MARKER = "Final Answer:";

/**
 * The protocol instructions.
 *
 * Deliberately short. This text sits in the frozen system prompt on every
 * request, so every sentence is paid for on every turn — and small models
 * follow three crisp rules better than ten hedged ones.
 */
export function reactProtocol(tools: ToolSpec[]): string {
  const lines = [
    "You work in a loop of three steps. Emit them in exactly this format.",
    "",
    "Thought: what you know, and what you need next.",
    "Action: the name of one tool, alone on the line.",
    "Action Input: a single JSON object of that tool's arguments.",
    "",
    "Then STOP. Do not write anything after Action Input — the tool has not run",
    "yet, and its result will be given to you as `Observation:` in the next",
    "message. Never write an Observation yourself; anything you invent there is",
    "false and will mislead you.",
    "",
    "When you have enough to answer, emit instead:",
    "",
    "Thought: why you are done.",
    `${FINAL_ANSWER_MARKER} your answer to the user.`,
    "",
    "Rules:",
    "- One Action per response. Never two.",
    "- Action must be one of the tools listed below, spelled exactly.",
    "- Action Input must be valid JSON on a single line, even if empty: {}",
    "- Do not put an Action and a Final Answer in the same response.",
    "",
    "Tools:",
  ];
  for (const t of tools) {
    const params = Object.entries(t.parameters.properties)
      .map(([name, p]) => {
        const req = t.parameters.required?.includes(name) ? "" : "?";
        return `${name}${req}: ${p.type}`;
      })
      .join(", ");
    lines.push(`- ${t.name}(${params}) — ${t.description}`);
  }
  return lines.join("\n");
}

export interface ReactStep {
  reasoning: Reasoning[];
  /** At most one — ReAct is one action per turn by construction. */
  toolCalls: ToolCall[];
  /** Present when the model declared itself done. */
  finalAnswer?: string;
  /** Set when the response could not be parsed into either an action or an answer. */
  malformed?: string;
}

/**
 * Parse one ReAct response.
 *
 * The ordering of checks encodes the safety policy: a Final Answer wins over an
 * Action, because a model that emits both is confused and stopping is the safe
 * reading. An Action with unparseable input becomes `malformed` rather than a
 * call with empty arguments — guessing `{}` for a tool that needs a path is how
 * you get `read_file()` on the working directory.
 */
export function parseReact(text: string, tools: ToolSpec[], idPrefix = "react"): ReactStep {
  // Defend against the model writing an Observation despite the stop sequence
  // (a provider may not honour it, or may return the stop text).
  const body = text.split(/\n\s*Observation\s*:/i)[0] ?? text;

  const reasoning = extractThought(body);

  const finalIdx = indexOfMarker(body, FINAL_ANSWER_MARKER);
  if (finalIdx >= 0) {
    const answer = body.slice(finalIdx + FINAL_ANSWER_MARKER.length).trim();
    return { reasoning, toolCalls: [], finalAnswer: answer };
  }

  const action = extractAction(body);
  if (!action) {
    // No Action and no Final Answer. The forgiving reading is that the model
    // simply answered in prose — common, and treating it as an error would
    // strand a correct response. Only genuinely empty output is malformed.
    const prose = stripMarkers(body).trim();
    if (prose) return { reasoning, toolCalls: [], finalAnswer: prose };
    return { reasoning, toolCalls: [], malformed: "response contained no Action and no answer" };
  }

  const known = tools.find((t) => t.name === action.name);
  if (!known) {
    return {
      reasoning,
      toolCalls: [],
      malformed:
        `unknown tool "${action.name}". Available: ${tools.map((t) => t.name).join(", ")}`,
    };
  }

  if (action.rawInput !== undefined && action.args === undefined) {
    return {
      reasoning,
      toolCalls: [],
      malformed: `Action Input for ${action.name} was not valid JSON: ${truncate(action.rawInput)}`,
    };
  }

  return {
    reasoning,
    toolCalls: [
      {
        id: `${idPrefix}_${Date.now().toString(36)}_${action.name}`,
        name: action.name,
        args: action.args ?? {},
      },
    ],
  };
}

/**
 * Build the correction sent back when parsing fails.
 *
 * Phrased as an instruction rather than a complaint, and it restates the format
 * — a model that drifted out of the format cannot be corrected by being told it
 * drifted. It has to be shown the shape again.
 */
export function reactCorrection(problem: string): string {
  return [
    `Your last response could not be used: ${problem}`,
    "",
    "Respond again using exactly this format:",
    "",
    "Thought: <your reasoning>",
    "Action: <one tool name>",
    "Action Input: <one line of JSON>",
    "",
    `or, if you are done: ${FINAL_ANSWER_MARKER} <your answer>`,
  ].join("\n");
}

// ── parsing internals ───────────────────────────────────────────────────────

function extractThought(text: string): Reasoning[] {
  const matches = [...text.matchAll(/^[ \t]*Thought[ \t]*:[ \t]*(.*)$/gim)];
  if (matches.length === 0) return [];

  // Take everything from the first Thought marker to the next marker, so
  // multi-line reasoning survives — models rarely keep it to one line.
  const start = matches[0]!.index! + matches[0]![0].indexOf(":") + 1;
  const rest = text.slice(start);
  const end = rest.search(/^[ \t]*(Action|Final Answer)[ \t]*:/im);
  const thought = (end >= 0 ? rest.slice(0, end) : rest).trim();
  return thought ? [{ kind: "text", text: thought }] : [];
}

interface ParsedAction {
  name: string;
  args?: Record<string, unknown>;
  rawInput?: string;
}

function extractAction(text: string): ParsedAction | undefined {
  const m = /^[ \t]*Action[ \t]*:[ \t]*(.+)$/im.exec(text);
  if (!m) return undefined;
  const line = m[1]!.trim();

  // Inline form: `Action: read_file({"path": "a"})`. Small models produce this
  // constantly despite being told to use Action Input, so accept it.
  const inline = /^([A-Za-z_][\w-]*)\s*\((.*)\)\s*$/s.exec(line);
  if (inline) {
    const raw = inline[2]!.trim();
    return { name: inline[1]!, ...parseArgs(raw || "{}") };
  }

  const name = /^([A-Za-z_][\w-]*)/.exec(line)?.[1];
  if (!name) return undefined;

  // Capture the input in two steps rather than one regex. A single pattern
  // needs the `m` flag to find the marker at a line start, but `m` also makes
  // `$` mean end-of-*line* — which silently truncates a multi-line value at the
  // first newline. Fenced JSON is exactly that case, and it fails by producing
  // empty arguments rather than an error.
  const after = text.slice(m.index + m[0].length);
  const marker = /^[ \t]*Action[ \t_]*Input[ \t]*:[ \t]*/im.exec(after);
  if (!marker) return { name };

  const rest = after.slice(marker.index + marker[0].length);
  const nextMarker = rest.search(/\n[ \t]*(?:Thought|Action|Final Answer)[ \t]*:/i);
  const raw = (nextMarker >= 0 ? rest.slice(0, nextMarker) : rest).trim();

  return { name, ...parseArgs(raw) };
}

function parseArgs(raw: string): { args?: Record<string, unknown>; rawInput?: string } {
  if (!raw) return { args: {} };
  const cleaned = raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/, "")
    .trim();
  if (!cleaned) return { args: {} };

  const candidates = [cleaned, sliceBraces(cleaned)].filter(Boolean);
  for (const c of candidates) {
    try {
      const v = JSON.parse(c!);
      if (v && typeof v === "object" && !Array.isArray(v)) {
        return { args: v as Record<string, unknown> };
      }
    } catch {
      /* try the next shape */
    }
  }
  return { rawInput: cleaned };
}

function sliceBraces(s: string): string | undefined {
  const a = s.indexOf("{");
  const b = s.lastIndexOf("}");
  return a >= 0 && b > a ? s.slice(a, b + 1) : undefined;
}

/** Case-insensitive marker search that returns the index of the marker itself. */
function indexOfMarker(text: string, marker: string): number {
  const re = new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  return text.search(re);
}

function stripMarkers(text: string): string {
  return text.replace(/^[ \t]*(Thought|Action|Action[ _]?Input)[ \t]*:.*$/gim, "");
}

function truncate(s: string, n = 120): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
}
