import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile, readdir } from "node:fs/promises";
import { resolve, relative, isAbsolute } from "node:path";
import { ToolRegistry, type Tool, type ToolContext } from "./registry.js";
import { editTool, globTool, grepTool } from "./edit.js";

const exec = promisify(execFile);

/**
 * Confine a model-supplied path to the workspace.
 *
 * Exported because every filesystem tool needs it and each one re-implementing
 * the check is how one of them ends up not having it.
 */
export function safePath(ctx: ToolContext, p: string): string {
  const abs = isAbsolute(p) ? p : resolve(ctx.cwd, p);
  const rel = relative(ctx.cwd, abs);
  if (rel.startsWith("..")) throw new Error(`path escapes workspace: ${p}`);
  return abs;
}

// ---------------------------------------------------------------------------
// A small default toolset — enough to make the demo real.
// ---------------------------------------------------------------------------

export const readFileTool: Tool = {
  spec: {
    name: "read_file",
    description: "Read a UTF-8 text file from the workspace.",
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: "Path relative to the workspace root." } },
      required: ["path"],
    },
  },
  async run(args, ctx) {
    return await readFile(safePath(ctx, String(args["path"])), "utf8");
  },
};

export const writeFileTool: Tool = {
  spec: {
    name: "write_file",
    description: "Write a UTF-8 text file in the workspace, replacing any existing content.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path relative to the workspace root." },
        content: { type: "string", description: "Full file content to write." },
      },
      required: ["path", "content"],
    },
    sideEffects: true,
  },
  async run(args, ctx) {
    const p = safePath(ctx, String(args["path"]));
    await writeFile(p, String(args["content"]), "utf8");
    return `wrote ${relative(ctx.cwd, p)} (${String(args["content"]).length} bytes)`;
  },
};

export const listDirTool: Tool = {
  spec: {
    name: "list_dir",
    description: "List entries in a workspace directory.",
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: "Directory path; defaults to root." } },
    },
  },
  async run(args, ctx) {
    const p = safePath(ctx, String(args["path"] ?? "."));
    const entries = await readdir(p, { withFileTypes: true });
    return entries.map((e) => (e.isDirectory() ? `${e.name}/` : e.name)).join("\n") || "(empty)";
  },
};

export const shellTool: Tool = {
  spec: {
    name: "shell",
    description: "Run a shell command in the workspace and return combined stdout/stderr.",
    parameters: {
      type: "object",
      properties: { command: { type: "string", description: "Command line to run." } },
      required: ["command"],
    },
    sideEffects: true,
  },
  async run(args, ctx) {
    const { stdout, stderr } = await exec("/bin/sh", ["-c", String(args["command"])], {
      cwd: ctx.cwd,
      maxBuffer: 8 * 1024 * 1024,
      timeout: 120_000,
    });
    return [stdout, stderr].filter(Boolean).join("\n").trim() || "(no output)";
  },
};

/**
 * The default toolset.
 *
 * Ordered read-only first, and `edit` before `write_file`, because the tool
 * block is read top to bottom and the earlier entries anchor what "normal"
 * looks like. Editing should feel like the default way to change a file;
 * rewriting one should feel like the exception it is.
 */
export function defaultTools(): ToolRegistry {
  return new ToolRegistry()
    .register(readFileTool)
    .register(globTool)
    .register(grepTool)
    .register(listDirTool)
    .register(editTool)
    .register(writeFileTool)
    .register(shellTool);
}
