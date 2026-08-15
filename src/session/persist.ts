import { Transcript } from "../core/transcript.js";
import { SessionStore, type SessionRow } from "./store.js";
import { repairTranscript, type RepairReport } from "../context/repair.js";
import type { FeinEvent } from "../core/types.js";

/**
 * Binds a Transcript to a SessionStore.
 *
 * This is a *sink*, not a wrapper: the Transcript API is unchanged and it
 * still works with no store at all. That matters because persistence must not
 * become load-bearing for correctness — the loop's guarantees (append-only,
 * monotonic renders) hold identically in memory, and the database is a
 * durability and recall layer bolted onto the side of them.
 *
 * It rides `Transcript.onAppend`, which already exists precisely because the
 * log is append-only. There is no update path to keep in sync, which is the
 * usual source of persistence bugs.
 */
export class PersistentSession {
  readonly transcript: Transcript;
  readonly store: SessionStore;
  private sessionId: string;
  private seq = 0;

  private constructor(transcript: Transcript, store: SessionStore, sessionId: string, seq: number) {
    this.transcript = transcript;
    this.store = store;
    this.sessionId = sessionId;
    this.seq = seq;
    transcript.onAppend((e) => this.persist(e));
  }

  get id(): string {
    return this.sessionId;
  }

  /** Start a fresh persisted session. */
  static create(store: SessionStore, opts: { title?: string; parentId?: string } = {}): PersistentSession {
    const row = store.createSession(opts);
    return new PersistentSession(new Transcript(), store, row.id, 0);
  }

  /**
   * Resume an existing session by replaying its events into a fresh
   * Transcript.
   *
   * Replay uses `hydrate`, which appends without re-notifying listeners — so
   * resuming does not write every historical event back to disk. The
   * distinction between "this happened" and "this is being re-read" is exactly
   * the kind of thing an append-only log makes easy and a mutable store makes
   * subtly wrong.
   */
  static resume(store: SessionStore, sessionId: string): PersistentSession {
    const row = store.getSession(sessionId);
    if (!row) throw new Error(`no such session: ${sessionId}`);
    const events = store.loadEvents(sessionId);
    const transcript = new Transcript();
    transcript.hydrate(events);
    const session = new PersistentSession(transcript, store, sessionId, events.length);

    // Repair before anyone renders. A session interrupted between a tool call
    // and its result is invalid for every provider, so without this a crash
    // makes the session permanently unresumable. The backfilled results are
    // appended as real events (and therefore persisted) so the log records the
    // interruption rather than papering over it.
    session.lastRepair = repairTranscript(transcript);
    return session;
  }

  /** What resume had to fix, if anything. Empty on a clean session. */
  lastRepair: RepairReport = { backfilled: [], orphaned: [] };

  private persist(e: FeinEvent): void {
    this.store.appendEvent(this.sessionId, this.seq++, e);
  }

  /**
   * Fork a child session for a compaction epoch.
   *
   * The parent keeps every event; the child starts from the summary. This is
   * the difference between compaction that *loses* detail and compaction that
   * *relocates* it — after this, the pre-epoch history is still on disk, still
   * searchable, and still reachable via `store.lineage()`.
   */
  forkForEpoch(summary: string, reason: string): PersistentSession {
    const parent = this.store.getSession(this.sessionId)!;
    const child = this.store.createSession({
      parentId: this.sessionId,
      ...(parent.title ? { title: parent.title } : {}),
      meta: { epochReason: reason },
    });
    const next = new PersistentSession(new Transcript(), this.store, child.id, 0);
    next.transcript.epoch(reason, summary);
    return next;
  }

  row(): SessionRow {
    return this.store.getSession(this.sessionId)!;
  }
}
