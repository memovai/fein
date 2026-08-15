import type { ToolCall, ToolResult, ToolSpec } from "../core/types.js";

export interface ToolContext {
  cwd: string;
  /** Set false to make side-effecting tools refuse (dry-run / untrusted mode). */
  allowSideEffects: boolean;
}

export interface Tool {
  spec: ToolSpec;
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<string>;
}

export class ToolRegistry {
  private tools = new Map<string, Tool>();
  /**
   * The tool block is a cache prefix. Registering a tool mid-session shifts
   * every downstream token and invalidates the provider cache, so we version
   * the registry and require an explicit epoch to change it during a run.
   */
  private frozen = false;

  register(tool: Tool): this {
    if (this.frozen) {
      throw new Error(
        `tool registry is frozen: registering "${tool.spec.name}" mid-run would invalidate the ` +
          `prompt cache. Declare it before the first turn — with deferLoading: true if it ` +
          `should only become visible later — then surface it with agent.surfaceTool(). ` +
          `An epoch also works, at the price of a full cache flush.`,
      );
    }
    this.tools.set(tool.spec.name, tool);
    return this;
  }

  /**
   * Declare a tool that exists from turn one but stays out of the model's
   * context until surfaced. This is how a dynamic tool set stays cache-safe:
   * the tool block is fixed at the front of the prefix, and surfacing later
   * appends a block instead of rewriting that front.
   */
  registerDeferred(tool: Tool): this {
    return this.register({ ...tool, spec: { ...tool.spec, deferLoading: true } });
  }

  freeze(): this {
    this.frozen = true;
    return this;
  }

  unfreezeForEpoch(): this {
    this.frozen = false;
    return this;
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  /** Specs in stable (insertion) order — order is part of the cache prefix. */
  specs(): ToolSpec[] {
    return [...this.tools.values()].map((t) => t.spec);
  }

  names(): string[] {
    return [...this.tools.keys()];
  }

  async execute(call: ToolCall, ctx: ToolContext): Promise<ToolResult> {
    const tool = this.tools.get(call.name);
    if (!tool) {
      return {
        callId: call.id,
        content: `Unknown tool "${call.name}". Available: ${this.names().join(", ")}`,
        isError: true,
      };
    }
    const invalid = validateArgs(tool.spec, call.args);
    if (invalid) {
      return { callId: call.id, content: `Invalid arguments: ${invalid}`, isError: true };
    }
    if (tool.spec.sideEffects && !ctx.allowSideEffects) {
      return {
        callId: call.id,
        content: `Refused: "${call.name}" has side effects and side effects are disabled.`,
        isError: true,
      };
    }
    try {
      return { callId: call.id, content: await tool.run(call.args, ctx), isError: false };
    } catch (err) {
      return { callId: call.id, content: `Error: ${errMsg(err)}`, isError: true };
    }
  }
}

/**
 * Schema validation is not a nicety here — it is the safety rail that makes
 * delegating tool-call construction to a 3B model tolerable. A small model
 * gets arguments wrong far more often than it gets *intent* wrong, so we
 * catch shape errors locally and cheaply rather than discovering them via a
 * failed side effect or a confused cloud model.
 */
export function validateArgs(spec: ToolSpec, args: Record<string, unknown>): string | undefined {
  const problems: string[] = [];
  for (const req of spec.parameters.required ?? []) {
    if (args[req] === undefined || args[req] === null || args[req] === "") {
      problems.push(`missing required "${req}"`);
    }
  }
  for (const [key, value] of Object.entries(args)) {
    const p = spec.parameters.properties[key];
    if (!p) {
      problems.push(`unknown property "${key}"`);
      continue;
    }
    const actual = Array.isArray(value) ? "array" : typeof value;
    const expected = p.type === "integer" ? "number" : p.type;
    if (expected !== "any" && actual !== expected) {
      problems.push(`"${key}" should be ${p.type}, got ${actual}`);
    }
    if (p.enum && typeof value === "string" && !p.enum.includes(value)) {
      problems.push(`"${key}" must be one of ${p.enum.join("|")}`);
    }
  }
  return problems.length ? problems.join("; ") : undefined;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
