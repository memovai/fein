import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readdir, access } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import type { ToolCall, ToolResult, ChatMessage } from "../core/types.js";

const exec = promisify(execFile);

/**
 * Lifecycle hooks.
 *
 * Two kinds, deliberately:
 *
 *  - **In-process hooks** are functions. They are for programmatic embedding:
 *    logging, metrics, custom policy in the host application.
 *  - **Filesystem hooks** are executables in a directory. They are for the
 *    user of the CLI, who has no build step and should not need one to say
 *    "never let it run `git push` without asking me".
 *
 * The design decision worth stating: `beforeTool` can **deny**. A hook that
 * can only observe is a logging system, not a safety mechanism, and the whole
 * reason to run code at that moment is to be able to stop what is about to
 * happen. Denials return a normal tool result marked as an error, so the model
 * sees the refusal and can adapt rather than crashing the loop.
 *
 * Hooks that throw are *ignored*, not fatal — with one exception. A broken
 * logging hook must not take down a session. But a broken `beforeTool` hook is
 * ambiguous about permission, and ambiguous permission is denial: if the gate
 * cannot answer, the answer is no.
 */

export interface HookContext {
  sessionId?: string;
  cwd: string;
  step: number;
}

export interface ToolDecision {
  allow: boolean;
  reason?: string;
}

export interface Hooks {
  sessionStart?(ctx: HookContext): Promise<void> | void;
  sessionEnd?(ctx: HookContext, summary: { steps: number; text: string }): Promise<void> | void;
  beforeModel?(ctx: HookContext, slot: string, messages: ChatMessage[]): Promise<void> | void;
  afterModel?(ctx: HookContext, slot: string, text: string): Promise<void> | void;
  /** Return `{allow: false}` to block the call. */
  beforeTool?(ctx: HookContext, call: ToolCall): Promise<ToolDecision | void> | ToolDecision | void;
  afterTool?(ctx: HookContext, call: ToolCall, result: ToolResult): Promise<void> | void;
  beforeCompact?(ctx: HookContext, approxTokens: number): Promise<void> | void;
}

export class HookRunner {
  private hooks: Hooks[] = [];
  private scriptDir: string | undefined;
  private scripts = new Map<string, string[]>();

  add(h: Hooks): this {
    this.hooks.push(h);
    return this;
  }

  /**
   * Load executables from `<dir>/<event>/`. Each becomes a hook for that
   * event. Naming by directory rather than by filename convention means a hook
   * can be a shell script, a binary, or anything else executable — the
   * filesystem is the plugin API.
   */
  async loadScripts(dir: string): Promise<this> {
    this.scriptDir = dir;
    for (const event of HOOK_EVENTS) {
      const eventDir = join(dir, event);
      try {
        const entries = await readdir(eventDir, { withFileTypes: true });
        const runnable: string[] = [];
        for (const e of entries) {
          if (!e.isFile()) continue;
          const p = join(eventDir, e.name);
          try {
            await access(p, constants.X_OK);
            runnable.push(p);
          } catch {
            // Present but not executable — a common mistake, silently skipped
            // rather than crashing a session the user did not know had hooks.
          }
        }
        if (runnable.length) this.scripts.set(event, runnable.sort());
      } catch {
        // No directory for this event; normal.
      }
    }
    return this;
  }

  get scriptCount(): number {
    return [...this.scripts.values()].reduce((n, v) => n + v.length, 0);
  }

  get root(): string | undefined {
    return this.scriptDir;
  }

  async sessionStart(ctx: HookContext): Promise<void> {
    await this.fanOut("sessionStart", (h) => h.sessionStart?.(ctx), ctx, {});
  }

  async sessionEnd(ctx: HookContext, summary: { steps: number; text: string }): Promise<void> {
    await this.fanOut("sessionEnd", (h) => h.sessionEnd?.(ctx, summary), ctx, summary);
  }

  async beforeModel(ctx: HookContext, slot: string, messages: ChatMessage[]): Promise<void> {
    await this.fanOut("beforeModel", (h) => h.beforeModel?.(ctx, slot, messages), ctx, { slot });
  }

  async afterModel(ctx: HookContext, slot: string, text: string): Promise<void> {
    await this.fanOut("afterModel", (h) => h.afterModel?.(ctx, slot, text), ctx, { slot });
  }

  async afterTool(ctx: HookContext, call: ToolCall, result: ToolResult): Promise<void> {
    await this.fanOut("afterTool", (h) => h.afterTool?.(ctx, call, result), ctx, {
      tool: call.name,
      ok: !result.isError,
    });
  }

  async beforeCompact(ctx: HookContext, approxTokens: number): Promise<void> {
    await this.fanOut("beforeCompact", (h) => h.beforeCompact?.(ctx, approxTokens), ctx, {
      approxTokens,
    });
  }

  /**
   * The gate. Any hook may veto; the first denial wins and short-circuits.
   *
   * A script denies by exiting non-zero — the natural convention, and one that
   * makes `exit 1` in a two-line shell script a working policy. Its stderr
   * becomes the reason the model is shown, so a hook can explain itself.
   */
  async beforeTool(ctx: HookContext, call: ToolCall): Promise<ToolDecision> {
    for (const h of this.hooks) {
      if (!h.beforeTool) continue;
      try {
        const d = await h.beforeTool(ctx, call);
        if (d && d.allow === false) {
          return { allow: false, ...(d.reason ? { reason: d.reason } : {}) };
        }
      } catch (err) {
        // Fail closed: a gate that cannot decide has not granted permission.
        return { allow: false, reason: `beforeTool hook failed: ${errMsg(err)}` };
      }
    }

    for (const script of this.scripts.get("beforeTool") ?? []) {
      try {
        await this.runScript(script, ctx, { tool: call.name, args: call.args });
      } catch (err) {
        const reason = stderrOf(err) || errMsg(err);
        return { allow: false, reason: `blocked by hook ${script}: ${reason}` };
      }
    }
    return { allow: true };
  }

  private async fanOut(
    event: string,
    call: (h: Hooks) => unknown,
    ctx: HookContext,
    payload: Record<string, unknown>,
  ): Promise<void> {
    for (const h of this.hooks) {
      try {
        await call(h);
      } catch {
        // Observability hooks are advisory. One that throws must not abort a
        // turn the user is paying for.
      }
    }
    for (const script of this.scripts.get(event) ?? []) {
      try {
        await this.runScript(script, ctx, payload);
      } catch {
        /* same */
      }
    }
  }

  private async runScript(
    script: string,
    ctx: HookContext,
    payload: Record<string, unknown>,
  ): Promise<string> {
    const { stdout } = await exec(script, [], {
      cwd: ctx.cwd,
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
      env: {
        ...process.env,
        FEIN_SESSION_ID: ctx.sessionId ?? "",
        FEIN_STEP: String(ctx.step),
        FEIN_PAYLOAD: JSON.stringify(payload),
      },
    });
    return stdout;
  }
}

export const HOOK_EVENTS = [
  "sessionStart",
  "sessionEnd",
  "beforeModel",
  "afterModel",
  "beforeTool",
  "afterTool",
  "beforeCompact",
] as const;

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function stderrOf(e: unknown): string {
  const s = (e as { stderr?: unknown })?.stderr;
  return typeof s === "string" ? s.trim() : "";
}
