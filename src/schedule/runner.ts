import { JobStore, parseCron, cronMatches, nextRun, type Job } from "./cron.js";
import { localTime } from "../cli/render.js";

/**
 * The scheduler loop.
 *
 * Ticks once a minute, fires whatever matches, and records the outcome. Three
 * decisions worth stating:
 *
 *  - **No backfill.** We only ever ask "does this match *now*", never "what
 *    did we miss". A laptop that was closed overnight wakes to zero pending
 *    runs, not eleven simultaneous ones.
 *
 *  - **One run per job at a time.** A job whose previous run is still going
 *    is skipped rather than queued. Agent runs have unbounded duration, so
 *    overlapping fires would stack indefinitely — and two copies of the same
 *    agent editing the same workspace is a race nobody asked for.
 *
 *  - **A failing job does not stop the scheduler.** The failure is recorded
 *    against that job's history and the loop continues. Failures are visible
 *    via `fein cron runs <name>` rather than by the whole scheduler dying.
 */

export type JobExecutor = (job: Job) => Promise<{ ok: boolean; output: string; sessionId?: string }>;

export interface SchedulerOptions {
  store: JobStore;
  execute: JobExecutor;
  onEvent?: (msg: string) => void;
  /** Tick interval. Only overridden in tests. */
  tickMs?: number;
}

export class Scheduler {
  private timer: NodeJS.Timeout | undefined;
  private running = new Set<string>();
  private lastTickMinute = -1;

  constructor(private readonly opts: SchedulerOptions) {}

  start(): void {
    if (this.timer) return;
    // Tick more often than once a minute so a slightly late tick does not skip
    // a whole minute; `lastTickMinute` dedupes within the same minute.
    this.timer = setInterval(() => void this.tick(), this.opts.tickMs ?? 20_000);
    this.timer.unref?.();
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  get activeCount(): number {
    return this.running.size;
  }

  async tick(now: Date = new Date()): Promise<void> {
    const minute = Math.floor(now.getTime() / 60_000);
    if (minute === this.lastTickMinute) return;
    this.lastTickMinute = minute;

    for (const job of this.opts.store.list()) {
      if (!job.enabled) continue;
      if (this.running.has(job.id)) {
        this.opts.onEvent?.(`skip ${job.name}: previous run still in flight`);
        continue;
      }
      let matches = false;
      try {
        matches = cronMatches(parseCron(job.schedule), now);
      } catch (err) {
        this.opts.onEvent?.(`job ${job.name} has an invalid schedule: ${errMsg(err)}`);
        continue;
      }
      if (matches) void this.fire(job);
    }
  }

  /** Run a job immediately, ignoring its schedule. Used by `cron run`. */
  async fire(job: Job): Promise<void> {
    if (this.running.has(job.id)) return;
    this.running.add(job.id);
    const runId = this.opts.store.startRun(job.id);
    this.opts.onEvent?.(`run ${job.name}`);
    try {
      const r = await this.opts.execute(job);
      this.opts.store.finishRun(runId, job.id, r.ok, r.output, r.sessionId);
      this.opts.onEvent?.(`${r.ok ? "done" : "failed"} ${job.name}`);
    } catch (err) {
      this.opts.store.finishRun(runId, job.id, false, errMsg(err));
      this.opts.onEvent?.(`failed ${job.name}: ${errMsg(err)}`);
    } finally {
      this.running.delete(job.id);
    }
  }
}

/** Human-readable schedule summary for `fein cron list`. */
export function describeJob(job: Job): string {
  const next = job.enabled ? nextRun(job.schedule) : undefined;
  const parts = [
    `${job.enabled ? "●" : "○"} ${job.name}`,
    `  schedule: ${job.schedule}${next ? `  (next ${localTime(next)})` : ""}`,
    `  prompt:   ${job.prompt.length > 70 ? `${job.prompt.slice(0, 67)}...` : job.prompt}`,
    `  runs:     ${job.runCount}${job.lastStatus ? ` (last: ${job.lastStatus})` : ""}` +
      `${job.allowSideEffects ? "  [side effects ENABLED]" : "  [read-only]"}`,
  ];
  return parts.join("\n");
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
