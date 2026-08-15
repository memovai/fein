import { stdout } from "node:process";
import { join } from "node:path";
import { SessionStore } from "../session/store.js";
import { JobStore, nextRun } from "../schedule/cron.js";
import { Scheduler, describeJob } from "../schedule/runner.js";
import { SkillLibrary } from "../skills/skill.js";
import { HookRunner, HOOK_EVENTS } from "../hooks/hooks.js";
import { openWorkspace } from "../config/workspace.js";
import { buildRouter, type FeinConfig } from "./../config/profiles.js";
import { c, localTime } from "./render.js";

/**
 * Management commands.
 *
 * These exist because the durable pieces — sessions, jobs, skills, hooks —
 * are useless if you cannot inspect them. An agent with persistent memory and
 * no way to see what it remembers is not trustworthy; an agent with scheduled
 * jobs and no way to see whether they ran is not operable.
 */

// ── sessions ────────────────────────────────────────────────────────────────

export function cmdSessions(cwd: string, args: string[]): void {
  const store = new SessionStore(join(cwd, ".fein/sessions.db"));
  try {
    const sub = args[0] ?? "list";

    if (sub === "list") {
      const rows = store.listSessions(Number(args[1] ?? 20));
      if (rows.length === 0) return void stdout.write(c.dim("no sessions yet\n"));
      for (const s of rows) {
        const when = localTime(new Date(s.updatedAt));
        const gen = s.generation > 0 ? c.yellow(` gen${s.generation}`) : "";
        stdout.write(
          `${c.bold(s.id)}${gen}  ${c.dim(when)}  ${store.eventCount(s.id)} events\n` +
            `  ${s.title ?? c.dim("(untitled)")}\n`,
        );
      }
      return;
    }

    if (sub === "show") {
      const id = args[1];
      if (!id) return void stdout.write("usage: fein sessions show <id>\n");
      const events = store.loadEvents(id);
      for (const e of events) {
        if (e.channel !== "main") continue;
        const when = new Date(e.ts).toISOString().slice(11, 19);
        const text =
          e.kind === "user" || e.kind === "assistant"
            ? e.text
            : e.kind === "epoch"
              ? `[epoch: ${e.reason}]\n${e.snapshot}`
              : e.kind === "tool_result"
                ? e.result.content.slice(0, 200)
                : "";
        if (text.trim()) stdout.write(`${c.dim(when)} ${c.cyan(e.kind)}\n${text}\n\n`);
      }
      return;
    }

    if (sub === "search") {
      const q = args.slice(1).join(" ");
      if (!q) return void stdout.write("usage: fein sessions search <query>\n");
      const hits = store.search(q, { limit: 15 });
      if (hits.length === 0) return void stdout.write(c.dim(`no matches for "${q}"\n`));
      for (const h of hits) {
        const when = localTime(new Date(h.ts));
        stdout.write(
          `${c.dim(when)} ${c.bold(h.sessionTitle ?? h.sessionId)} ${c.dim(`· ${h.kind}`)}\n` +
            `  ${h.text.slice(0, 220).replace(/\s+/g, " ")}\n\n`,
        );
      }
      return;
    }

    if (sub === "lineage") {
      const id = args[1];
      if (!id) return void stdout.write("usage: fein sessions lineage <id>\n");
      const chain = store.lineage(id);
      chain.forEach((s, i) => {
        const arrow = i === 0 ? "" : c.dim(" ↳ compacted from ");
        stdout.write(
          `${arrow}${c.bold(s.id)} gen${s.generation} · ${store.eventCount(s.id)} events` +
            `${s.meta["epochReason"] ? c.dim(` · ${String(s.meta["epochReason"])}`) : ""}\n`,
        );
      });
      return;
    }

    stdout.write("usage: fein sessions [list|show <id>|search <q>|lineage <id>]\n");
  } finally {
    store.close();
  }
}

// ── skills ──────────────────────────────────────────────────────────────────

export async function cmdSkills(cwd: string, args: string[]): Promise<void> {
  const lib = await new SkillLibrary(join(cwd, ".fein/skills")).load();
  const sub = args[0] ?? "list";

  if (sub === "list") {
    const skills = lib.list();
    if (skills.length === 0) {
      stdout.write(
        c.dim(
          `no skills in ${join(cwd, ".fein/skills")}\n` +
            `the agent writes them itself with write_skill, or add a directory with a SKILL.md\n`,
        ),
      );
      return;
    }
    for (const s of skills) stdout.write(`${c.bold(s.name)}\n  ${s.description}\n`);
    return;
  }

  if (sub === "show") {
    const name = args[1];
    if (!name) return void stdout.write("usage: fein skills show <name>\n");
    stdout.write(`${await lib.body(name)}\n`);
    return;
  }

  stdout.write("usage: fein skills [list|show <name>]\n");
}

// ── hooks ───────────────────────────────────────────────────────────────────

export async function cmdHooks(cwd: string): Promise<void> {
  const dir = join(cwd, ".fein/hooks");
  const runner = await new HookRunner().loadScripts(dir);
  stdout.write(`hooks root: ${dir}\n`);
  if (runner.scriptCount === 0) {
    stdout.write(
      c.dim(
        `no executable hooks found.\n` +
          `create one with:\n` +
          `  mkdir -p ${dir}/beforeTool\n` +
          `  printf '#!/bin/sh\\ncase "$FEIN_PAYLOAD" in *rm\\\\ -rf*) echo "refusing rm -rf" >&2; exit 1;; esac\\n' \\\n` +
          `    > ${dir}/beforeTool/no-rm-rf && chmod +x ${dir}/beforeTool/no-rm-rf\n\n` +
          `events: ${HOOK_EVENTS.join(", ")}\n` +
          `env available to a hook: FEIN_SESSION_ID, FEIN_STEP, FEIN_PAYLOAD (JSON)\n` +
          `a beforeTool hook that exits non-zero blocks the call; its stderr is shown to the model.\n`,
      ),
    );
    return;
  }
  stdout.write(`${runner.scriptCount} executable hook(s) registered\n`);
}

// ── cron ────────────────────────────────────────────────────────────────────

export async function cmdCron(
  cwd: string,
  args: string[],
  cfg: FeinConfig,
  onEvent: (e: never) => void,
): Promise<void> {
  const store = new JobStore(join(cwd, ".fein/jobs.db"));
  try {
    const sub = args[0] ?? "list";

    if (sub === "list") {
      const jobs = store.list();
      if (jobs.length === 0) {
        stdout.write(
          c.dim(
            'no scheduled jobs.\n  fein cron add <name> "<cron>" "<prompt>"\n' +
              '  e.g. fein cron add triage "0 9 * * 1-5" "Summarize new issues"\n',
          ),
        );
        return;
      }
      for (const j of jobs) stdout.write(`${describeJob(j)}\n\n`);
      return;
    }

    if (sub === "add") {
      const [, name, schedule, ...rest] = args;
      const prompt = rest.join(" ");
      if (!name || !schedule || !prompt) {
        stdout.write('usage: fein cron add <name> "<cron expr>" "<prompt>" [--write]\n');
        return;
      }
      const allowSideEffects = rest.includes("--write");
      const job = store.create({
        name,
        schedule,
        prompt: prompt.replace(/\s*--write\s*/, " ").trim(),
        allowSideEffects,
      });
      const next = nextRun(job.schedule);
      stdout.write(
        `added ${c.bold(job.name)} (${job.schedule})\n` +
          `  next run: ${next ? localTime(next) : "never"}\n` +
          `  ${allowSideEffects ? c.yellow("side effects ENABLED") : c.green("read-only")}\n`,
      );
      return;
    }

    if (sub === "rm" || sub === "remove") {
      const name = args[1];
      if (!name) return void stdout.write("usage: fein cron rm <name>\n");
      store.remove(name);
      stdout.write(`removed ${name}\n`);
      return;
    }

    if (sub === "enable" || sub === "disable") {
      const name = args[1];
      if (!name) return void stdout.write(`usage: fein cron ${sub} <name>\n`);
      store.setEnabled(name, sub === "enable");
      stdout.write(`${sub}d ${name}\n`);
      return;
    }

    if (sub === "runs") {
      const name = args[1];
      const job = name ? store.get(name) : undefined;
      if (!job) return void stdout.write("usage: fein cron runs <name>\n");
      const runs = store.runs(job.id);
      if (runs.length === 0) return void stdout.write(c.dim("no runs yet\n"));
      for (const r of runs) {
        const when = localTime(new Date(r.startedAt));
        const dur = r.endedAt ? `${((r.endedAt - r.startedAt) / 1000).toFixed(1)}s` : "running";
        const mark = r.ok === null ? c.yellow("…") : r.ok ? c.green("ok") : c.red("fail");
        stdout.write(`${mark} ${c.dim(when)} ${dur}${r.sessionId ? ` ${c.dim(r.sessionId)}` : ""}\n`);
        if (r.output) stdout.write(`   ${r.output.slice(0, 200).replace(/\s+/g, " ")}\n`);
      }
      return;
    }

    // `run` and `serve` actually execute jobs, so they need a real agent.
    if (sub === "run" || sub === "serve") {
      const scheduler = new Scheduler({
        store,
        onEvent: (m) => stdout.write(`${c.dim(new Date().toISOString().slice(11, 19))} ${m}\n`),
        execute: async (job) => {
          const ws = await openWorkspace({
            cwd,
            router: buildRouter(cfg),
            title: `cron: ${job.name}`,
            allowSideEffects: job.allowSideEffects,
            onEvent: onEvent as never,
          });
          try {
            const r = await ws.agent.run(job.prompt);
            return {
              ok: true,
              output: r.text,
              ...(ws.agent.session ? { sessionId: ws.agent.session.id } : {}),
            };
          } finally {
            ws.close();
          }
        },
      });

      if (sub === "run") {
        const name = args[1];
        const job = name ? store.get(name) : undefined;
        if (!job) return void stdout.write("usage: fein cron run <name>\n");
        await scheduler.fire(job);
        return;
      }

      stdout.write(`${c.bold("fein cron serve")} — ticking; Ctrl-C to stop\n`);
      for (const j of store.list().filter((j) => j.enabled)) {
        const n = nextRun(j.schedule);
        stdout.write(c.dim(`  ${j.name}: next ${n ? localTime(n) : "never"}\n`));
      }
      scheduler.start();
      await new Promise(() => {}); // run until interrupted
      return;
    }

    stdout.write(
      "usage: fein cron [list|add|rm|enable|disable|runs|run|serve]\n",
    );
  } finally {
    store.close();
  }
}
