import { readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import { join, basename } from "node:path";
import type { Tool } from "../tools/registry.js";

/**
 * Skills: reusable procedural knowledge the agent accumulates.
 *
 * The design constraint that shapes everything here is **progressive
 * disclosure under a cache guarantee**:
 *
 *  - The skill *index* (name + one-line description) goes in the frozen system
 *    prompt. It is small, it is stable for the life of the process, and it is
 *    what the model needs to know a skill exists.
 *  - The skill *body* is loaded on demand via a tool call, which appends to
 *    the transcript like any other observation. Cache-safe by construction.
 *
 * Loading every skill body up front would be the obvious implementation and it
 * is wrong twice: it burns tokens on skills that will not be used this
 * session, and — worse — it means adding a skill changes the front of the
 * prompt, so every skill written invalidates every cached conversation.
 *
 * Skills are plain Markdown directories on disk (`SKILL.md` + optional files),
 * so they are greppable, diffable, reviewable, and shareable without this
 * harness. A skill format only readable by the tool that wrote it is a trap.
 */

export interface Skill {
  name: string;
  description: string;
  /** Full body, loaded lazily. */
  path: string;
}

export interface SkillFrontmatter {
  name?: string;
  description?: string;
}

/** Parse the leading `---` YAML-ish block. Deliberately a subset — see below. */
export function parseFrontmatter(src: string): { meta: SkillFrontmatter; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(src);
  if (!m) return { meta: {}, body: src };
  const meta: SkillFrontmatter = {};
  for (const line of m[1]!.split(/\r?\n/)) {
    const kv = /^(\w+)\s*:\s*(.*)$/.exec(line.trim());
    if (!kv) continue;
    const key = kv[1]!;
    const value = kv[2]!.replace(/^["']|["']$/g, "").trim();
    if (key === "name" || key === "description") meta[key] = value;
  }
  return { meta, body: src.slice(m[0].length) };
}

export class SkillLibrary {
  private skills = new Map<string, Skill>();

  constructor(readonly root: string) {}

  /**
   * Scan the skills directory. A missing directory is not an error — most
   * projects will not have one, and a harness that refuses to start without a
   * skills folder is hostile.
   */
  async load(): Promise<this> {
    let entries: string[];
    try {
      entries = (await readdir(this.root, { withFileTypes: true }))
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
    } catch {
      return this;
    }

    for (const dir of entries) {
      const path = join(this.root, dir, "SKILL.md");
      try {
        const src = await readFile(path, "utf8");
        const { meta } = parseFrontmatter(src);
        const name = meta.name ?? dir;
        this.skills.set(name, {
          name,
          description: meta.description ?? firstLine(src),
          path,
        });
      } catch {
        // A malformed or unreadable skill is skipped, not fatal. One bad file
        // must not take down a session that never intended to use it.
      }
    }
    return this;
  }

  list(): Skill[] {
    // Sorted by name: the index sits in the frozen system prompt, so its order
    // must not depend on filesystem enumeration order or the prefix changes
    // between runs and every cache misses.
    return [...this.skills.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  get(name: string): Skill | undefined {
    return this.skills.get(name);
  }

  /** The cheap, always-resident index. Goes in the system prompt. */
  index(): string {
    const skills = this.list();
    if (skills.length === 0) return "";
    return [
      "Available skills — read one with the `read_skill` tool when the task matches:",
      ...skills.map((s) => `- ${s.name}: ${s.description}`),
    ].join("\n");
  }

  async body(name: string): Promise<string> {
    const skill = this.skills.get(name);
    if (!skill) throw new Error(`no such skill: ${name}`);
    const src = await readFile(skill.path, "utf8");
    return parseFrontmatter(src).body.trim();
  }

  /** Register a newly written skill without a rescan. */
  add(skill: Skill): void {
    this.skills.set(skill.name, skill);
  }
}

function firstLine(src: string): string {
  const line = src
    .split(/\r?\n/)
    .map((l) => l.replace(/^#+\s*/, "").trim())
    .find((l) => l.length > 0);
  return line ?? "(no description)";
}

// ── tools ───────────────────────────────────────────────────────────────────

export function readSkillTool(library: SkillLibrary): Tool {
  return {
    spec: {
      name: "read_skill",
      description:
        "Read the full text of a skill listed in your skill index. Do this before starting a " +
        "task the skill covers — the index only tells you a skill exists, not how to apply it.",
      parameters: {
        type: "object",
        properties: { name: { type: "string", description: "Skill name from the index." } },
        required: ["name"],
      },
    },
    async run(args) {
      return await library.body(String(args["name"]));
    },
  };
}

/**
 * `write_skill` — the agent records what it learned.
 *
 * This is the half that makes skills compound rather than merely exist. It is
 * marked `sideEffects` so that, under FE!N's trust tiers, a locally-delegated
 * call to it must pass the verifier: a small model writing durable
 * instructions that will steer every future session is exactly the kind of
 * unrecoverable action the tier system is for.
 */
export function writeSkillTool(library: SkillLibrary): Tool {
  return {
    spec: {
      name: "write_skill",
      description:
        "Record a reusable procedure you worked out, so future sessions do not re-derive it. " +
        "Write it for a competent stranger: what problem it solves, when it applies, the exact " +
        "steps, and the traps. Do not record one-off facts or anything the repository already " +
        "documents — those belong in the codebase, not in a skill.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Short kebab-case identifier." },
          description: { type: "string", description: "One line: when this skill applies." },
          body: { type: "string", description: "Full Markdown body." },
        },
        required: ["name", "description", "body"],
      },
      sideEffects: true,
    },
    async run(args) {
      const name = String(args["name"])
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, "-")
        .replace(/^-+|-+$/g, "");
      if (!name) throw new Error("skill name reduced to empty after sanitization");

      const dir = join(library.root, name);
      await mkdir(dir, { recursive: true });
      const path = join(dir, "SKILL.md");
      const description = String(args["description"]).replace(/\n/g, " ").trim();
      const content =
        `---\nname: ${name}\ndescription: ${description}\n---\n\n` +
        `${String(args["body"]).trim()}\n`;
      await writeFile(path, content, "utf8");

      library.add({ name, description, path });
      return (
        `Wrote skill "${name}" to ${path}.\n` +
        `Note: the skill index is part of this session's frozen system prompt, so this skill ` +
        `becomes visible to you in the next session, not this one. You already know its content.`
      );
    },
  };
}

export function skillTools(library: SkillLibrary): Tool[] {
  return [readSkillTool(library), writeSkillTool(library)];
}

export function skillDirName(path: string): string {
  return basename(path);
}
