#!/usr/bin/env node
// node:sqlite is behind an experimental flag; the warning is noise for users
// who did not choose SQLite, they chose an agent. Only this one is filtered —
// every other warning still reaches the terminal.
process.removeAllListeners("warning");
process.on("warning", (w) => {
  if (w.name === "ExperimentalWarning" && /SQLite/i.test(w.message)) return;
  console.warn(w.stack ?? `${w.name}: ${w.message}`);
});
import { createInterface } from "node:readline/promises";
import { stdin, stdout, argv, env, exit } from "node:process";
import { readFile } from "node:fs/promises";
import { Agent, type FeinTrace } from "../core/loop.js";
import { buildRouter, hybridProfile, cloudOnlyProfile, localOnlyProfile, type FeinConfig } from "../config/profiles.js";
import { defaultTools } from "../tools/builtin.js";
import { buildDemoAgent } from "./demo.js";
import { openWorkspace } from "../config/workspace.js";
import { cmdSessions, cmdSkills, cmdHooks, cmdCron } from "./commands.js";
import { c, renderTrace, BANNER } from "./render.js";

async function loadConfig(path?: string): Promise<FeinConfig> {
  if (path) return JSON.parse(await readFile(path, "utf8")) as FeinConfig;
  const profile = env["FEIN_PROFILE"] ?? "hybrid";
  if (profile === "cloud") return cloudOnlyProfile(env["FEIN_CLOUD_MODEL"]);
  if (profile === "local") return localOnlyProfile(env["FEIN_LOCAL_MODEL"]);
  return hybridProfile({
    ...(env["FEIN_CLOUD_MODEL"] ? { cloudModel: env["FEIN_CLOUD_MODEL"] } : {}),
    ...(env["FEIN_LOCAL_MODEL"] ? { localModel: env["FEIN_LOCAL_MODEL"] } : {}),
  });
}

async function cmdDemo(): Promise<void> {
  stdout.write(`${BANNER}\n${c.dim("offline demo — every model is scripted, no network\n")}\n`);
  const agent = buildDemoAgent(renderTrace);
  stdout.write(`${c.bold("bindings")}\n${agent.router.describe()}\n`);
  stdout.write(`\n${c.bold("task")}  Find out why the test suite is failing.\n`);

  await agent.run("Find out why the test suite is failing.");

  stdout.write(`\n${c.bold("ledger")}\n${agent.ledger.format({ in: 3, out: 15 })}\n`);
  stdout.write(
    `\n${c.dim(
      "The think model decided to run `npm test` itself — its authority is untouched — but it never\n" +
        "saw the 330-line log. A local model compressed it to 43 tokens first. That saving\n" +
        "compounds over every remaining turn, and the raw log never left this machine.\n",
    )}`,
  );
}

async function cmdChat(configPath?: string, resume?: string): Promise<void> {
  const cfg = await loadConfig(configPath);
  const router = buildRouter(cfg);
  const ws = await openWorkspace({
    cwd: process.cwd(),
    router,
    onEvent: renderTrace,
    ...(resume ? { resumeSessionId: resume } : {}),
  });
  const agent = ws.agent;

  stdout.write(`${BANNER}\n\n${c.bold("bindings")}\n${router.describe()}\n`);
  stdout.write(`${c.dim(`workspace: ${process.cwd()}\n`)}`);
  if (agent.session) {
    stdout.write(
      c.dim(`session:   ${agent.session.id}${resume ? " (resumed)" : ""}\n`),
    );
  }
  const extras = [
    ws.skills.list().length ? `${ws.skills.list().length} skill(s)` : "",
    ws.hooks.scriptCount ? `${ws.hooks.scriptCount} hook(s)` : "",
    ws.contextFiles.length ? ws.contextFiles.join(", ") : "",
  ].filter(Boolean);
  if (extras.length) stdout.write(c.dim(`loaded:    ${extras.join(" · ")}\n`));
  stdout.write(`${c.dim("commands: /ledger  /view  /bindings  /session  /prompt  /exit\n")}`);
  stdout.write(c.dim("type while it works to steer it — your line lands at the next turn boundary\n"));

  const rl = createInterface({ input: stdin, output: stdout });

  // One line handler for both states, because the terminal has one keyboard.
  // While a run is in flight a typed line is a *steer*, not a new task: it
  // joins the conversation already happening instead of racing it. That is the
  // whole point — you can see the agent going the wrong way and say so without
  // killing the context it has built.
  let deliverInput: ((line: string) => void) | undefined;
  rl.on("line", (raw) => {
    const line = raw.trim();
    if (!line) return;
    if (agent.isRunning) {
      const depth = agent.steer(line);
      stdout.write(
        c.dim(`  ↳ queued${depth > 1 ? ` (${depth})` : ""} — applies at the next turn boundary\n`),
      );
      return;
    }
    deliverInput?.(line);
    deliverInput = undefined;
  });
  const nextLine = (): Promise<string> =>
    new Promise((resolve) => {
      deliverInput = resolve;
    });

  try {
    for (;;) {
      stdout.write(`\n${c.bold("›")} `);
      const line = await nextLine();

      if (line === "/exit" || line === "/quit") break;
      if (line === "/ledger") {
        stdout.write(`${agent.ledger.format(thinkRates(cfg))}\n`);
        continue;
      }
      if (line === "/bindings") {
        stdout.write(`${router.describe()}\n`);
        continue;
      }
      if (line === "/session") {
        stdout.write(
          agent.session
            ? `${agent.session.id} · ${agent.transcript.all.length} events\n`
            : "no persistent session\n",
        );
        continue;
      }
      if (line === "/prompt") {
        for (const s of agent.promptSections) {
          stdout.write(`  ${s.name.padEnd(12)} ${s.volatility.padEnd(7)} ${s.bytes}B  ${c.dim(s.hash)}\n`);
        }
        continue;
      }
      if (line === "/view") {
        stdout.write(`${JSON.stringify(agent.view(), null, 2)}\n`);
        continue;
      }

      try {
        await agent.run(line);
      } catch (err) {
        stdout.write(c.red(`\nerror: ${err instanceof Error ? err.message : String(err)}\n`));
      }
      stdout.write(`\n${c.dim(agent.ledger.format(thinkRates(cfg)))}\n`);
    }
  } finally {
    rl.close();
    ws.close();
  }
}

function thinkRates(cfg: FeinConfig): { in: number; out: number } | undefined {
  const target = cfg.bind.think;
  const id =
    typeof target === "string" ? target : Array.isArray(target) ? target[0] : target?.port;
  const port = cfg.ports.find((p) => p.id === id);
  return port ? { in: port.costPerMTokIn ?? 0, out: port.costPerMTokOut ?? 0 } : undefined;
}

async function cmdOnce(prompt: string, configPath?: string): Promise<void> {
  const cfg = await loadConfig(configPath);
  const ws = await openWorkspace({
    cwd: process.cwd(),
    router: buildRouter(cfg),
    title: prompt.slice(0, 60),
    onEvent: renderTrace,
  });
  try {
    await ws.agent.run(prompt);
    stdout.write(`\n${c.dim(ws.agent.ledger.format(thinkRates(cfg)))}\n`);
    if (ws.agent.session) stdout.write(c.dim(`session: ${ws.agent.session.id}\n`));
  } finally {
    ws.close();
  }
}

function usage(): void {
  stdout.write(
    `${BANNER}

` +
      `usage:
` +
      `  fein demo                       offline walkthrough of the hybrid loop (no keys)
` +
      `  fein chat [--resume <id>]       interactive session
` +
      `  fein run "<prompt>"             single task, then exit
` +
      `
` +
      `  fein sessions [list|show <id>|search <q>|lineage <id>]
` +
      `  fein skills   [list|show <name>]
` +
      `  fein hooks                      show hook setup
` +
      `  fein cron     [list|add|rm|enable|disable|runs|run|serve]
` +
      `
` +
      `env:
` +
      `  FEIN_PROFILE=hybrid|cloud|local   (default hybrid)
` +
      `  FEIN_CLOUD_MODEL, FEIN_LOCAL_MODEL
` +
      `  ANTHROPIC_API_KEY
` +
      `
` +
      `workspace layout (all optional, discovered automatically):
` +
      `  .fein/sessions.db  .fein/jobs.db  .fein/skills/  .fein/hooks/<event>/
` +
      `  AGENTS.md | CLAUDE.md | .cursorrules   project context
`,
  );
}

async function main(): Promise<void> {
  const [cmd, ...rest] = argv.slice(2);
  const cfgIdx = rest.indexOf("--config");
  const configPath = cfgIdx >= 0 ? rest[cfgIdx + 1] : undefined;
  const resumeIdx = rest.indexOf("--resume");
  const resume = resumeIdx >= 0 ? rest[resumeIdx + 1] : undefined;

  switch (cmd) {
    case "demo":
      return await cmdDemo();
    case "chat":
      return await cmdChat(configPath, resume);
    case "run": {
      const prompt = rest.filter((a) => a !== "--config" && a !== configPath).join(" ");
      if (!prompt) return usage();
      return await cmdOnce(prompt, configPath);
    }
    case "sessions":
      return cmdSessions(process.cwd(), rest);
    case "skills":
      return await cmdSkills(process.cwd(), rest);
    case "hooks":
      return await cmdHooks(process.cwd());
    case "cron":
      return await cmdCron(process.cwd(), rest, await loadConfig(configPath), renderTrace as never);
    default:
      return usage();
  }
}

main().catch((err) => {
  stdout.write(c.red(`\nfatal: ${err instanceof Error ? err.stack : String(err)}\n`));
  exit(1);
});
