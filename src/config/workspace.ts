import { readFile, access } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Agent, type AgentOptions, type FeinTrace } from "../core/loop.js";
import { Router } from "../models/router.js";
import { ToolRegistry } from "../tools/registry.js";
import { defaultTools } from "../tools/builtin.js";
import { SessionStore } from "../session/store.js";
import { PersistentSession } from "../session/persist.js";
import { sessionSearchTool, sessionLineageTool } from "../session/search-tool.js";
import { SkillLibrary, skillTools } from "../skills/skill.js";
import { HookRunner } from "../hooks/hooks.js";
import { sweepSpill } from "../context/spill.js";
import { fenceProjectContext } from "../steps/prompts.js";

/**
 * Assembles a fully-equipped agent from a workspace directory.
 *
 * Everything here is *discovered*, not configured: if `.fein/skills` exists
 * you get skills, if `.fein/hooks` exists you get hooks, if `AGENTS.md` exists
 * it becomes project context. A harness that requires a config file before it
 * does anything useful is a harness people abandon during setup.
 *
 * The layout, all under the workspace root:
 *
 *   .fein/sessions.db     durable sessions + full-text recall
 *   .fein/jobs.db         scheduled jobs
 *   .fein/skills/<name>/SKILL.md
 *   .fein/hooks/<event>/<executable>
 *   AGENTS.md | CLAUDE.md | .cursorrules    project context (tier 2)
 */

export const CONTEXT_FILES = ["AGENTS.md", "CLAUDE.md", ".cursorrules"] as const;

/**
 * Identity, as distinct from project convention.
 *
 * `AGENTS.md` answers "how does this repository work". `SOUL.md` answers "who
 * are you" — voice, standing preferences, what to never do, how much to explain.
 * They are different enough to deserve different files and different trust:
 *
 *  - `~/.fein/SOUL.md` is **yours**. Nobody else can commit to it, so it is
 *    trusted and goes into tier 1 of the system prompt unfenced, as operator
 *    instruction.
 *  - `<workspace>/SOUL.md` is in a repo, which means anyone who can land a pull
 *    request can edit it. It is fenced exactly like project context, because the
 *    trust boundary is a property of *who can write the file*, not of what the
 *    file is called.
 *
 * That split is the whole reason this is not just another entry in
 * CONTEXT_FILES.
 */
export const SOUL_FILE = "SOUL.md";

export interface WorkspaceOptions {
  cwd: string;
  router: Router;
  /** Reuse an existing session id instead of starting a new one. */
  resumeSessionId?: string;
  title?: string;
  /** Disable persistence (used by tests and one-shot runs). */
  ephemeral?: boolean;
  allowSideEffects?: boolean;
  maxSteps?: number;
  onEvent?: (e: FeinTrace) => void;
  extraTools?: ToolRegistry;
}

export interface Workspace {
  agent: Agent;
  store: SessionStore | undefined;
  skills: SkillLibrary;
  hooks: HookRunner;
  contextFiles: string[];
  close(): void;
}

export async function openWorkspace(opts: WorkspaceOptions): Promise<Workspace> {
  const root = join(opts.cwd, ".fein");

  // Fire-and-forget: expired spill dumps age out on open. Not awaited — a
  // slow disk must not delay the session, and a failed sweep costs nothing
  // but the bytes it was about to reclaim.
  void sweepSpill(join(root, "spill"));

  // ── identity (tier 1) and project context (tier 2) ────────────────────────
  const found: string[] = [];
  const fenced: string[] = [];

  // User-level identity: trusted, because only the user can write it.
  let soul = "";
  const userSoul = join(homedir(), ".fein", SOUL_FILE);
  try {
    const body = (await readFile(userSoul, "utf8")).trim();
    if (body) {
      soul = body;
      found.push(`~/.fein/${SOUL_FILE}`);
    }
  } catch {
    /* absent; normal */
  }

  // Workspace-level identity: fenced, because a repo has contributors.
  try {
    const body = await readFile(join(opts.cwd, SOUL_FILE), "utf8");
    const block = fenceProjectContext(SOUL_FILE, body);
    if (block) {
      found.push(SOUL_FILE);
      fenced.push(block);
    }
  } catch {
    /* absent; normal */
  }
  for (const name of CONTEXT_FILES) {
    const p = join(opts.cwd, name);
    try {
      await access(p);
      const body = await readFile(p, "utf8");
      const block = fenceProjectContext(name, body);
      if (block) {
        found.push(name);
        fenced.push(block);
      }
    } catch {
      /* absent; normal */
    }
  }

  // ── skills ────────────────────────────────────────────────────────────────
  const skills = await new SkillLibrary(join(root, "skills")).load();

  // ── hooks ─────────────────────────────────────────────────────────────────
  const hooks = await new HookRunner().loadScripts(join(root, "hooks"));

  // ── tools ─────────────────────────────────────────────────────────────────
  const tools = opts.extraTools ?? defaultTools();
  for (const t of skillTools(skills)) tools.register(t);

  // ── session ───────────────────────────────────────────────────────────────
  let store: SessionStore | undefined;
  let session: PersistentSession | undefined;
  if (!opts.ephemeral) {
    store = new SessionStore(join(root, "sessions.db"));
    session = opts.resumeSessionId
      ? PersistentSession.resume(store, opts.resumeSessionId)
      : PersistentSession.create(store, opts.title ? { title: opts.title } : {});

    // Recall tools need a live handle to the *current* session, which moves
    // when a compaction epoch forks. A thunk, not a captured string.
    const currentId = () => session!.id;
    tools.register(sessionSearchTool(store, currentId));
    tools.register(sessionLineageTool(store, currentId));
  }

  const agentOpts: AgentOptions = {
    router: opts.router,
    tools,
    cwd: opts.cwd,
    hooks,
    skills,
    ...(session ? { session } : {}),
    ...(fenced.length ? { projectContext: fenced.join("\n\n") } : {}),
    ...(soul ? { identity: soul } : {}),
    ...(opts.allowSideEffects !== undefined ? { allowSideEffects: opts.allowSideEffects } : {}),
    ...(opts.maxSteps !== undefined ? { maxSteps: opts.maxSteps } : {}),
    ...(opts.onEvent ? { onEvent: opts.onEvent } : {}),
  };

  return {
    agent: new Agent(agentOpts),
    store,
    skills,
    hooks,
    contextFiles: found,
    close: () => store?.close(),
  };
}
