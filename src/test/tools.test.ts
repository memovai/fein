import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { editTool, globTool, grepTool } from "../tools/edit.js";
import { defaultTools } from "../tools/builtin.js";

async function workspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "fein-tools-"));
  await mkdir(join(dir, "src"), { recursive: true });
  await mkdir(join(dir, "node_modules/pkg"), { recursive: true });
  await writeFile(join(dir, "src/a.ts"), "export const one = 1;\nexport const two = 2;\n");
  await writeFile(join(dir, "src/b.ts"), "import { one } from './a.js';\nconsole.log(one);\n");
  await writeFile(join(dir, "node_modules/pkg/index.js"), "module.exports = { one: 1 };\n");
  return dir;
}

const ctx = (cwd: string) => ({ cwd, allowSideEffects: true });

// ── edit ────────────────────────────────────────────────────────────────────

test("edit replaces an exact string and reports the delta", async () => {
  const dir = await workspace();
  const out = await editTool.run(
    { path: "src/a.ts", old_string: "export const one = 1;", new_string: "export const one = 42;" },
    ctx(dir),
  );
  assert.match(out, /Edited src\/a\.ts/);
  assert.match(await readFile(join(dir, "src/a.ts"), "utf8"), /one = 42/);
});

test("edit refuses an ambiguous match rather than guessing", async () => {
  const dir = await workspace();
  await writeFile(join(dir, "src/dup.ts"), "const x = 1;\nconst x = 1;\n");

  await assert.rejects(
    () => editTool.run({ path: "src/dup.ts", old_string: "const x = 1;", new_string: "const x = 2;" }, ctx(dir)),
    /appears 2 times/,
    "editing the wrong one of two identical matches is unrecoverable",
  );

  // The file must be untouched by the refusal.
  assert.equal(await readFile(join(dir, "src/dup.ts"), "utf8"), "const x = 1;\nconst x = 1;\n");
});

test("edit replace_all is explicit opt-in", async () => {
  const dir = await workspace();
  await writeFile(join(dir, "src/dup.ts"), "const x = 1;\nconst x = 1;\n");
  const out = await editTool.run(
    { path: "src/dup.ts", old_string: "const x = 1;", new_string: "const x = 2;", replace_all: "true" },
    ctx(dir),
  );
  assert.match(out, /2 occurrences/);
  assert.equal(await readFile(join(dir, "src/dup.ts"), "utf8"), "const x = 2;\nconst x = 2;\n");
});

test("edit gives an actionable error when the string is not found", async () => {
  const dir = await workspace();
  await assert.rejects(
    () => editTool.run({ path: "src/a.ts", old_string: "does not exist", new_string: "x" }, ctx(dir)),
    /must match exactly, including indentation/,
    "whitespace is invisible and is the usual cause — the message must say so",
  );
});

test("edit rejects no-op and empty edits", async () => {
  const dir = await workspace();
  await assert.rejects(
    () => editTool.run({ path: "src/a.ts", old_string: "same", new_string: "same" }, ctx(dir)),
    /identical/,
  );
  await assert.rejects(
    () => editTool.run({ path: "src/a.ts", old_string: "", new_string: "x" }, ctx(dir)),
    /empty/,
  );
});

test("edit writes $ sequences literally (regression: silent data corruption)", async () => {
  // `String.replace(string, string)` interprets `$&`, `$$`, `$'` and "$`" in
  // the replacement. Before the fix, editing a file to contain `$&` wrote the
  // *matched text* instead — an editing tool quietly altering what you asked
  // it to write, with no error.
  const dir = await workspace();
  const tricky = "const t = `$& and $$ and $\' and $` done`;";
  await editTool.run(
    { path: "src/a.ts", old_string: "export const one = 1;", new_string: tricky },
    ctx(dir),
  );
  const after = await readFile(join(dir, "src/a.ts"), "utf8");
  assert.ok(after.includes(tricky), `replacement was reinterpreted: ${after.split("\n")[0]}`);
  assert.doesNotMatch(after, /export const one = 1;/, "the old text is gone");
});

test("replace_all is also literal", async () => {
  const dir = await workspace();
  await writeFile(join(dir, "src/dup.ts"), "X\nX\n");
  await editTool.run(
    { path: "src/dup.ts", old_string: "X", new_string: "$&$1", replace_all: "true" },
    ctx(dir),
  );
  assert.equal(await readFile(join(dir, "src/dup.ts"), "utf8"), "$&$1\n$&$1\n");
});

test("edit cannot escape the workspace", async () => {
  const dir = await workspace();
  await assert.rejects(
    () => editTool.run({ path: "../../etc/passwd", old_string: "a", new_string: "b" }, ctx(dir)),
    /escapes workspace/,
  );
});

// ── glob / grep ─────────────────────────────────────────────────────────────

test("glob finds files and skips node_modules", async () => {
  const dir = await workspace();
  const out = await globTool.run({ pattern: "**/*.ts" }, ctx(dir));
  assert.match(out, /src\/a\.ts/);
  assert.match(out, /src\/b\.ts/);
  assert.doesNotMatch(out, /node_modules/, "walking node_modules is pure cost");
});

test("grep returns path:line: text and skips node_modules", async () => {
  const dir = await workspace();
  const out = await grepTool.run({ pattern: "one", glob: "**/*.ts" }, ctx(dir));
  assert.match(out, /src\/a\.ts:1:/);
  assert.match(out, /src\/b\.ts:1:/);
  assert.doesNotMatch(out, /node_modules/);
});

test("grep reports absence without pretending it searched nothing", async () => {
  const dir = await workspace();
  const out = await grepTool.run({ pattern: "definitely_absent", glob: "**/*.ts" }, ctx(dir));
  assert.match(out, /No matches/);
  assert.match(out, /file\(s\)/, "saying how many files were searched distinguishes 'absent' from 'looked nowhere'");
});

test("grep surfaces an invalid regex instead of silently finding nothing", async () => {
  const dir = await workspace();
  await assert.rejects(
    () => grepTool.run({ pattern: "([unclosed", glob: "**/*.ts" }, ctx(dir)),
    /invalid regular expression/,
  );
});

// ── the permission hole this closes ─────────────────────────────────────────

test("search works with side effects disabled — read-only is usable, not crippled", async () => {
  const dir = await workspace();
  const tools = defaultTools();
  const readOnly = { cwd: dir, allowSideEffects: false };

  // shell is side-effecting, so it is refused...
  const shell = await tools.execute(
    { id: "1", name: "shell", args: { command: "grep -r one ." } },
    readOnly,
  );
  assert.equal(shell.isError, true);

  // ...but searching still works, which is the whole point.
  const grepped = await tools.execute(
    { id: "2", name: "grep", args: { pattern: "one", glob: "**/*.ts" } },
    readOnly,
  );
  assert.equal(grepped.isError, false);
  assert.match(grepped.content, /src\/a\.ts/);

  const globbed = await tools.execute({ id: "3", name: "glob", args: { pattern: "**/*.ts" } }, readOnly);
  assert.equal(globbed.isError, false);
});

test("the default toolset covers read, search, edit, and execute", () => {
  const names = defaultTools().names();
  for (const required of ["read_file", "glob", "grep", "list_dir", "edit", "write_file", "shell"]) {
    assert.ok(names.includes(required), `missing ${required}`);
  }
  // edit must be declared before write_file: the tool block is read in order,
  // and the earlier entry anchors what the normal way to change a file is.
  assert.ok(names.indexOf("edit") < names.indexOf("write_file"));
});
