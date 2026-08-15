import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Durable scheduled jobs.
 *
 * Two properties make this more than a `setInterval`:
 *
 *  1. **Jobs survive the process.** They live in SQLite alongside sessions, so
 *     a job survives a restart, a crash, and a laptop lid. A scheduler that
 *     forgets its jobs when you close the terminal is a timer, not
 *     infrastructure.
 *
 *  2. **Jobs run under the same permission machinery as interactive work.**
 *     A scheduled run gets the same tool registry, the same trust tiers, and
 *     the same hooks as a human-driven one. This is the property that is easy
 *     to get wrong and expensive to get wrong: an unattended agent with looser
 *     permissions than the attended one is exactly backwards, because nobody
 *     is watching.
 *
 * Missed runs are **not** backfilled. A job that should have fired at 3am
 * while the machine was asleep fires next at its next occurrence, not eleven
 * times at 8am. Catch-up storms are the classic cron failure and almost never
 * what anyone wants from an agent that spends money per run.
 */

export interface Job {
  id: string;
  name: string;
  /** Five-field cron: minute hour day-of-month month day-of-week. */
  schedule: string;
  /** The prompt handed to the agent when this job fires. */
  prompt: string;
  enabled: boolean;
  createdAt: number;
  lastRunAt: number | null;
  lastStatus: string | null;
  runCount: number;
  /** Side effects allowed for this job. Off unless explicitly enabled. */
  allowSideEffects: boolean;
}

export interface JobRun {
  id: string;
  jobId: string;
  startedAt: number;
  endedAt: number | null;
  ok: boolean | null;
  sessionId: string | null;
  output: string | null;
}

export class JobStore {
  private db: DatabaseSync;

  constructor(path = ".fein/jobs.db") {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        schedule TEXT NOT NULL,
        prompt TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        last_run_at INTEGER,
        last_status TEXT,
        run_count INTEGER NOT NULL DEFAULT 0,
        allow_side_effects INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS job_runs (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL REFERENCES jobs(id),
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        ok INTEGER,
        session_id TEXT,
        output TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_runs_job ON job_runs(job_id, started_at DESC);
    `);
  }

  create(opts: {
    name: string;
    schedule: string;
    prompt: string;
    allowSideEffects?: boolean;
  }): Job {
    parseCron(opts.schedule); // validate before persisting
    const job: Job = {
      id: `job_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
      name: opts.name,
      schedule: opts.schedule,
      prompt: opts.prompt,
      enabled: true,
      createdAt: Date.now(),
      lastRunAt: null,
      lastStatus: null,
      runCount: 0,
      allowSideEffects: opts.allowSideEffects ?? false,
    };
    this.db
      .prepare(
        `INSERT INTO jobs (id, name, schedule, prompt, enabled, created_at, allow_side_effects)
         VALUES (?, ?, ?, ?, 1, ?, ?)`,
      )
      .run(job.id, job.name, job.schedule, job.prompt, job.createdAt, job.allowSideEffects ? 1 : 0);
    return job;
  }

  list(): Job[] {
    return (this.db.prepare(`SELECT * FROM jobs ORDER BY name`).all() as Record<string, unknown>[]).map(
      toJob,
    );
  }

  get(nameOrId: string): Job | undefined {
    const r = this.db
      .prepare(`SELECT * FROM jobs WHERE id = ? OR name = ?`)
      .get(nameOrId, nameOrId) as Record<string, unknown> | undefined;
    return r ? toJob(r) : undefined;
  }

  setEnabled(nameOrId: string, enabled: boolean): void {
    this.db
      .prepare(`UPDATE jobs SET enabled = ? WHERE id = ? OR name = ?`)
      .run(enabled ? 1 : 0, nameOrId, nameOrId);
  }

  remove(nameOrId: string): void {
    const job = this.get(nameOrId);
    if (!job) return;
    this.db.prepare(`DELETE FROM job_runs WHERE job_id = ?`).run(job.id);
    this.db.prepare(`DELETE FROM jobs WHERE id = ?`).run(job.id);
  }

  startRun(jobId: string): string {
    const id = `run_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    this.db
      .prepare(`INSERT INTO job_runs (id, job_id, started_at) VALUES (?, ?, ?)`)
      .run(id, jobId, Date.now());
    return id;
  }

  finishRun(runId: string, jobId: string, ok: boolean, output: string, sessionId?: string): void {
    this.db
      .prepare(`UPDATE job_runs SET ended_at = ?, ok = ?, output = ?, session_id = ? WHERE id = ?`)
      .run(Date.now(), ok ? 1 : 0, output.slice(0, 8000), sessionId ?? null, runId);
    this.db
      .prepare(
        `UPDATE jobs SET last_run_at = ?, last_status = ?, run_count = run_count + 1 WHERE id = ?`,
      )
      .run(Date.now(), ok ? "ok" : "error", jobId);
  }

  runs(jobId: string, limit = 20): JobRun[] {
    return (
      this.db
        .prepare(`SELECT * FROM job_runs WHERE job_id = ? ORDER BY started_at DESC LIMIT ?`)
        .all(jobId, limit) as Record<string, unknown>[]
    ).map((r) => ({
      id: String(r["id"]),
      jobId: String(r["job_id"]),
      startedAt: Number(r["started_at"]),
      endedAt: r["ended_at"] === null ? null : Number(r["ended_at"]),
      ok: r["ok"] === null ? null : Number(r["ok"]) === 1,
      sessionId: (r["session_id"] as string | null) ?? null,
      output: (r["output"] as string | null) ?? null,
    }));
  }

  close(): void {
    this.db.close();
  }
}

function toJob(r: Record<string, unknown>): Job {
  return {
    id: String(r["id"]),
    name: String(r["name"]),
    schedule: String(r["schedule"]),
    prompt: String(r["prompt"]),
    enabled: Number(r["enabled"]) === 1,
    createdAt: Number(r["created_at"]),
    lastRunAt: r["last_run_at"] === null ? null : Number(r["last_run_at"]),
    lastStatus: (r["last_status"] as string | null) ?? null,
    runCount: Number(r["run_count"] ?? 0),
    allowSideEffects: Number(r["allow_side_effects"]) === 1,
  };
}

// ── cron parsing ────────────────────────────────────────────────────────────

export interface CronFields {
  minute: Set<number>;
  hour: Set<number>;
  dom: Set<number>;
  month: Set<number>;
  dow: Set<number>;
  /** True when day-of-month and day-of-week are both restricted (OR semantics). */
  domRestricted: boolean;
  dowRestricted: boolean;
}

const RANGES: Array<[keyof Omit<CronFields, "domRestricted" | "dowRestricted">, number, number]> = [
  ["minute", 0, 59],
  ["hour", 0, 23],
  ["dom", 1, 31],
  ["month", 1, 12],
  ["dow", 0, 6],
];

const ALIASES: Record<string, string> = {
  "@hourly": "0 * * * *",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@weekly": "0 0 * * 0",
  "@monthly": "0 0 1 * *",
};

export function parseCron(expr: string): CronFields {
  const src = ALIASES[expr.trim()] ?? expr.trim();
  const parts = src.split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(
      `invalid cron "${expr}": expected 5 fields (minute hour day-of-month month day-of-week)`,
    );
  }

  const out = {} as CronFields;
  for (let i = 0; i < RANGES.length; i++) {
    const [field, lo, hi] = RANGES[i]!;
    out[field] = parseField(parts[i]!, lo, hi, field);
  }
  out.domRestricted = parts[2] !== "*";
  out.dowRestricted = parts[4] !== "*";
  return out;
}

function parseField(spec: string, lo: number, hi: number, name: string): Set<number> {
  const values = new Set<number>();
  for (const chunk of spec.split(",")) {
    const stepped = chunk.split("/");
    const base = stepped[0]!;
    const step = stepped.length > 1 ? Number(stepped[1]) : 1;
    if (!Number.isInteger(step) || step < 1) {
      throw new Error(`invalid cron step in ${name}: "${chunk}"`);
    }

    let start: number;
    let end: number;
    if (base === "*") {
      start = lo;
      end = hi;
    } else if (base.includes("-")) {
      const [a, b] = base.split("-");
      start = Number(a);
      end = Number(b);
    } else {
      start = Number(base);
      end = stepped.length > 1 ? hi : start;
    }

    if (!Number.isInteger(start) || !Number.isInteger(end) || start < lo || end > hi || start > end) {
      throw new Error(`invalid cron ${name} field: "${chunk}" (allowed ${lo}-${hi})`);
    }
    for (let v = start; v <= end; v += step) values.add(v);
  }
  return values;
}

/**
 * Does this expression match this minute?
 *
 * Day-of-month and day-of-week use POSIX OR semantics when both are
 * restricted: `0 0 1 * 1` means "the 1st **or** any Monday", not their
 * intersection. This surprises almost everyone, so it is implemented
 * explicitly rather than falling out of an AND.
 */
export function cronMatches(fields: CronFields, when: Date): boolean {
  if (!fields.minute.has(when.getMinutes())) return false;
  if (!fields.hour.has(when.getHours())) return false;
  if (!fields.month.has(when.getMonth() + 1)) return false;

  const domHit = fields.dom.has(when.getDate());
  const dowHit = fields.dow.has(when.getDay());

  if (fields.domRestricted && fields.dowRestricted) return domHit || dowHit;
  if (fields.domRestricted) return domHit;
  if (fields.dowRestricted) return dowHit;
  return true;
}

/** Next firing time strictly after `from`. Scans minutes; bounded to ~2 years. */
export function nextRun(expr: string, from: Date = new Date()): Date | undefined {
  const fields = parseCron(expr);
  const t = new Date(from.getTime());
  t.setSeconds(0, 0);
  t.setMinutes(t.getMinutes() + 1);
  for (let i = 0; i < 366 * 24 * 60 * 2; i++) {
    if (cronMatches(fields, t)) return t;
    t.setMinutes(t.getMinutes() + 1);
  }
  return undefined;
}
