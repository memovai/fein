import { readFile, writeFile } from "node:fs/promises";
import { glob } from "node:fs/promises";
import { relative } from "node:path";
import type { Tool } from "./registry.js";
import { safePath } from "./builtin.js";

/**
 * Search and edit: the tools a harness about token economy cannot be missing.
 *
 * FE!N shipped with `read_file`, `write_file`, `list_dir`, and `shell`. That
 * set has two holes, and both of them work directly against the project's own
 * thesis:
 *
 * **1. No `edit` means every change costs a whole file.** To fix one line with
 * only `write_file`, the model must regenerate the entire file — in *output*
 * tokens, the most expensive tokens there are, at ~5x the input rate. A 400-line
 * file is ~4000 output tokens to change one character, every time. It is also
 * the highest-risk operation available: a full rewrite can silently drop code
 * the model was not thinking about. An `edit` that replaces an exact string
 * costs tokens proportional to the *change*, not to the file.
 *
 * **2. No `glob`/`grep` means search requires `shell`, which is
 * side-effecting** — so with `allowSideEffects: false` the agent could not
 * search at all. Read-only mode was not a safe mode, it was a crippled one.
 * (Our own benchmark hit this and quietly worked around it by reading whole
 * files, which is exactly the expensive pattern hole 1 describes.)
 *
 * Both are read-only where they can be, so they work under the strictest
 * permission setting — which is the setting scheduled jobs and subagents run
 * under by default.
 */

const MAX_RESULTS = 200;
const MAX_LINE = 400;

/** Directories never worth walking. Cheap to skip, expensive to traverse. */
const SKIP = /(^|\/)(node_modules|\.git|dist|build|coverage|\.next|target|vendor)(\/|$)/;

export const editTool: Tool = {
  spec: {
    name: "edit",
    description:
      "Replace an exact string in a file. Prefer this over write_file for any change to an " +
      "existing file: it costs tokens proportional to the edit rather than to the whole file, " +
      "and it cannot accidentally drop code you were not looking at. `old_string` must match " +
      "exactly, including indentation and line breaks, and must appear exactly once unless " +
      "`replace_all` is \"true\" — include surrounding lines to disambiguate.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path relative to the workspace root." },
        old_string: { type: "string", description: "Exact text to replace, including indentation." },
        new_string: { type: "string", description: "Replacement text." },
        replace_all: {
          type: "string",
          description: '"true" to replace every occurrence. Default "false".',
        },
      },
      required: ["path", "old_string", "new_string"],
    },
    sideEffects: true,
  },
  async run(args, ctx) {
    const p = safePath(ctx, String(args["path"]));
    const oldStr = String(args["old_string"]);
    const newStr = String(args["new_string"]);
    const all = String(args["replace_all"] ?? "false").toLowerCase() === "true";

    if (oldStr === newStr) throw new Error("old_string and new_string are identical — nothing to do");
    if (oldStr === "") throw new Error("old_string is empty; use write_file to create a file");

    const src = await readFile(p, "utf8");
    const count = occurrences(src, oldStr);

    if (count === 0) {
      // The most common failure, so the message has to be actionable rather
      // than just "not found": whitespace is invisible and is usually the cause.
      throw new Error(
        `old_string not found in ${relative(ctx.cwd, p)}. It must match exactly, including ` +
          `indentation and line endings. Re-read the file and copy the text verbatim.`,
      );
    }
    if (count > 1 && !all) {
      throw new Error(
        `old_string appears ${count} times in ${relative(ctx.cwd, p)}. Editing an ambiguous ` +
          `match could change the wrong one, so include surrounding lines to make it unique, ` +
          `or set replace_all to "true" if you mean all ${count}.`,
      );
    }

    // `String.replace(string, string)` interprets `$&`, `$$`, `$'` and "$`" in
    // the *replacement* as patterns. A replacement function does not — it is
    // returned verbatim. Without this, editing a file to contain `$&` silently
    // writes the matched text instead, and an editing tool that quietly alters
    // what you asked it to write is worse than one that refuses.
    //
    // (`split().join()` is already literal, so only the single-replace path was
    // affected — which is the default path, and therefore the common one.)
    const out = all ? src.split(oldStr).join(newStr) : src.replace(oldStr, () => newStr);
    await writeFile(p, out, "utf8");

    const delta = out.length - src.length;
    return (
      `Edited ${relative(ctx.cwd, p)} — replaced ${all ? `${count} occurrences` : "1 occurrence"}, ` +
      `${delta >= 0 ? "+" : ""}${delta} bytes.`
    );
  },
};

export const globTool: Tool = {
  spec: {
    name: "glob",
    description:
      "Find files by path pattern (e.g. `src/**/*.ts`). Read-only, so it works when side " +
      "effects are disabled. Skips node_modules, .git, dist and similar. Use this instead of " +
      "shelling out to `find`.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Glob pattern, relative to the workspace root." },
      },
      required: ["pattern"],
    },
  },
  async run(args, ctx) {
    const pattern = String(args["pattern"]);
    const hits: string[] = [];

    for await (const entry of glob(pattern, { cwd: ctx.cwd })) {
      const rel = String(entry);
      if (SKIP.test(rel)) continue;
      hits.push(rel);
      if (hits.length >= MAX_RESULTS) break;
    }

    if (hits.length === 0) return `No files match ${pattern}`;
    hits.sort();
    // Say when the list was cut. A silently truncated result set reads as "this
    // is everything", which is how an agent concludes a file does not exist.
    const capped = hits.length >= MAX_RESULTS ? `\n(stopped at ${MAX_RESULTS} matches)` : "";
    return hits.join("\n") + capped;
  },
};

export const grepTool: Tool = {
  spec: {
    name: "grep",
    description:
      "Search file contents with a regular expression and return matching lines as " +
      "`path:line: text`. Read-only, so it works when side effects are disabled. Narrow the " +
      "search with `glob` (e.g. `src/**/*.ts`) when you know the file type.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "JavaScript regular expression." },
        glob: {
          type: "string",
          description: "Optional path pattern to search within. Defaults to everything.",
        },
        ignore_case: { type: "string", description: '"true" for a case-insensitive search.' },
      },
      required: ["pattern"],
    },
  },
  async run(args, ctx) {
    const flags = String(args["ignore_case"] ?? "false").toLowerCase() === "true" ? "i" : "";
    let re: RegExp;
    try {
      re = new RegExp(String(args["pattern"]), flags);
    } catch (err) {
      throw new Error(`invalid regular expression: ${err instanceof Error ? err.message : err}`);
    }

    const pattern = String(args["glob"] ?? "**/*");
    const hits: string[] = [];
    let filesSearched = 0;

    for await (const entry of glob(pattern, { cwd: ctx.cwd })) {
      const rel = String(entry);
      if (SKIP.test(rel)) continue;

      let text: string;
      try {
        text = await readFile(safePath(ctx, rel), "utf8");
      } catch {
        continue; // directory, binary, or unreadable — not an error worth surfacing
      }
      // A NUL byte is the cheap, reliable binary signal. Grepping a binary
      // produces noise that is worse than useless in a context window.
      if (text.includes("\0")) continue;
      filesSearched++;

      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        if (!re.test(line)) continue;
        re.lastIndex = 0;
        const shown = line.length > MAX_LINE ? `${line.slice(0, MAX_LINE)}…` : line;
        hits.push(`${rel}:${i + 1}: ${shown.trim()}`);
        if (hits.length >= MAX_RESULTS) break;
      }
      if (hits.length >= MAX_RESULTS) break;
    }

    if (hits.length === 0) {
      return `No matches for /${args["pattern"]}/ in ${filesSearched} file(s) under ${pattern}`;
    }
    const capped = hits.length >= MAX_RESULTS ? `\n(stopped at ${MAX_RESULTS} matches)` : "";
    return hits.join("\n") + capped;
  },
};

/**
 * Count non-overlapping occurrences.
 *
 * `split().length - 1` rather than a global regex, because the needle is a
 * literal supplied by the model and may contain regex metacharacters. Escaping
 * it would work; not needing to escape it is better.
 */
function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}
