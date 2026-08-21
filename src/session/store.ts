import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { FeinEvent } from "../core/types.js";

/**
 * Durable session storage.
 *
 * Sessions are infrastructure here, not transcripts. Three things follow from
 * that, and each one is a capability the in-memory version simply cannot have:
 *
 *  1. **Work survives the process.** A scheduled job, a CLI run, and a chat
 *     turn can all write to the same session. Without this, "the agent
 *     remembers" is limited to one process lifetime.
 *
 *  2. **Compaction becomes lineage, not amnesia.** An epoch spawns a *child*
 *     session seeded by the summary, with a recorded parent link. The detail
 *     that fell out of the context window is still on disk and still
 *     addressable — so "compacted" stops meaning "lost". This is what makes
 *     the epoch strategy (DESIGN.md §2 Rule 3) safe to be aggressive about.
 *
 *  3. **Recall becomes searchable.** FTS5 over event text means the model can
 *     ask "what did we decide about X" across every prior session, instead of
 *     the harness guessing what to keep resident.
 *
 * Uses `node:sqlite`, built into Node — no dependency. WAL journaling so a
 * scheduler writing in the background does not block an interactive read.
 */

export interface SessionRow {
  id: string;
  parentId: string | null;
  title: string | null;
  createdAt: number;
  updatedAt: number;
  /** How many compaction generations deep this session is. */
  generation: number;
  meta: Record<string, unknown>;
}

export interface SearchHit {
  sessionId: string;
  sessionTitle: string | null;
  eventId: string;
  kind: string;
  text: string;
  ts: number;
  /** FTS relevance; lower is better (bm25). */
  score: number;
}

export class SessionStore {
  private db: DatabaseSync;

  constructor(path = ".fein/sessions.db") {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    // WAL lets a background scheduler append while a session reads.
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id          TEXT PRIMARY KEY,
        parent_id   TEXT REFERENCES sessions(id),
        title       TEXT,
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL,
        generation  INTEGER NOT NULL DEFAULT 0,
        meta        TEXT NOT NULL DEFAULT '{}'
      );

      CREATE TABLE IF NOT EXISTS events (
        id         TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id),
        seq        INTEGER NOT NULL,
        channel    TEXT NOT NULL,
        kind       TEXT NOT NULL,
        ts         INTEGER NOT NULL,
        json       TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id, seq);
      CREATE INDEX IF NOT EXISTS idx_sessions_parent ON sessions(parent_id);

      -- Searchable text only. Tool output and side-channel noise are excluded
      -- at write time (see searchableText) so recall surfaces decisions rather
      -- than the 3000-line log the observe model already threw away.
      CREATE VIRTUAL TABLE IF NOT EXISTS event_fts USING fts5(
        text, event_id UNINDEXED, session_id UNINDEXED, tokenize = 'porter'
      );
    `);
  }

  // ── sessions ──────────────────────────────────────────────────────────────

  createSession(opts: { title?: string; parentId?: string; meta?: Record<string, unknown> } = {}): SessionRow {
    const now = Date.now();
    const parent = opts.parentId ? this.getSession(opts.parentId) : undefined;
    const row: SessionRow = {
      id: `ses_${randomUUID().replace(/-/g, "").slice(0, 20)}`,
      parentId: opts.parentId ?? null,
      title: opts.title ?? null,
      createdAt: now,
      updatedAt: now,
      generation: parent ? parent.generation + 1 : 0,
      meta: opts.meta ?? {},
    };
    this.db
      .prepare(
        `INSERT INTO sessions (id, parent_id, title, created_at, updated_at, generation, meta)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.parentId,
        row.title,
        row.createdAt,
        row.updatedAt,
        row.generation,
        JSON.stringify(row.meta),
      );
    return row;
  }

  getSession(id: string): SessionRow | undefined {
    const r = this.db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(id) as
      | Record<string, unknown>
      | undefined;
    return r ? toSessionRow(r) : undefined;
  }

  setTitle(id: string, title: string): void {
    this.db
      .prepare(`UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?`)
      .run(title, Date.now(), id);
  }

  listSessions(limit = 50): SessionRow[] {
    return (
      this.db
        .prepare(`SELECT * FROM sessions ORDER BY updated_at DESC LIMIT ?`)
        .all(limit) as Record<string, unknown>[]
    ).map(toSessionRow);
  }

  /**
   * Walk from a session back to its root through compaction ancestry. This is
   * what makes an epoch recoverable: the summary is in the child, the detail
   * it replaced is in the parent, and the chain says how to get there.
   */
  lineage(id: string): SessionRow[] {
    const chain: SessionRow[] = [];
    let cur = this.getSession(id);
    const seen = new Set<string>();
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id);
      chain.push(cur);
      cur = cur.parentId ? this.getSession(cur.parentId) : undefined;
    }
    return chain;
  }

  /**
   * The oldest ancestor of a session — its identity across compactions.
   *
   * Cheaper than `lineage()` because it walks parent links without loading
   * event counts, and it is called on the request path.
   */
  lineageRoot(id: string): string {
    let cur = this.getSession(id);
    const seen = new Set<string>();
    while (cur?.parentId && !seen.has(cur.id)) {
      seen.add(cur.id);
      const parent = this.getSession(cur.parentId);
      if (!parent) break;
      cur = parent;
    }
    return cur?.id ?? id;
  }

  // ── events ────────────────────────────────────────────────────────────────

  appendEvent(sessionId: string, seq: number, event: FeinEvent): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO events (id, session_id, seq, channel, kind, ts, json)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(event.id, sessionId, seq, event.channel, event.kind, event.ts, JSON.stringify(event));
    this.db.prepare(`UPDATE sessions SET updated_at = ? WHERE id = ?`).run(event.ts, sessionId);

    const text = searchableText(event);
    if (text) {
      this.db
        .prepare(`INSERT INTO event_fts (text, event_id, session_id) VALUES (?, ?, ?)`)
        .run(text, event.id, sessionId);
    }
  }

  /** Replay a session's events in order. The basis of resume. */
  loadEvents(sessionId: string): FeinEvent[] {
    return (
      this.db
        .prepare(`SELECT json FROM events WHERE session_id = ? ORDER BY seq ASC`)
        .all(sessionId) as { json: string }[]
    ).map((r) => JSON.parse(r.json) as FeinEvent);
  }

  eventCount(sessionId: string): number {
    const r = this.db
      .prepare(`SELECT COUNT(*) AS n FROM events WHERE session_id = ?`)
      .get(sessionId) as { n: number };
    return r.n;
  }

  // ── search ────────────────────────────────────────────────────────────────

  /**
   * Full-text recall across sessions. `excludeSession` keeps the current
   * conversation out of its own search results, which otherwise dominate.
   */
  search(query: string, opts: { limit?: number; excludeSession?: string } = {}): SearchHit[] {
    const limit = opts.limit ?? 8;
    const sanitized = sanitizeFtsQuery(query);
    if (!sanitized) return [];

    const rows = this.db
      .prepare(
        `SELECT f.text AS text, f.event_id AS event_id, f.session_id AS session_id,
                e.kind AS kind, e.ts AS ts, s.title AS title, bm25(event_fts) AS score
         FROM event_fts f
         JOIN events   e ON e.id = f.event_id
         JOIN sessions s ON s.id = f.session_id
         WHERE event_fts MATCH ? AND f.session_id IS NOT ?
         ORDER BY score ASC
         LIMIT ?`,
      )
      .all(sanitized, opts.excludeSession ?? null, limit) as Record<string, unknown>[];

    return rows.map((r) => ({
      sessionId: String(r["session_id"]),
      sessionTitle: (r["title"] as string | null) ?? null,
      eventId: String(r["event_id"]),
      kind: String(r["kind"]),
      text: String(r["text"]),
      ts: Number(r["ts"]),
      score: Number(r["score"]),
    }));
  }

  close(): void {
    this.db.close();
  }
}

function toSessionRow(r: Record<string, unknown>): SessionRow {
  return {
    id: String(r["id"]),
    parentId: (r["parent_id"] as string | null) ?? null,
    title: (r["title"] as string | null) ?? null,
    createdAt: Number(r["created_at"]),
    updatedAt: Number(r["updated_at"]),
    generation: Number(r["generation"] ?? 0),
    meta: JSON.parse(String(r["meta"] ?? "{}")) as Record<string, unknown>,
  };
}

/**
 * What is worth indexing.
 *
 * Deliberately *not* everything. Tool output is excluded because it is bulky,
 * low-signal, and already summarized by the observe model — indexing it would make
 * every search return log lines instead of decisions. Side-channel events are
 * excluded because they are the harness talking to itself. What remains is
 * what a person would actually search for: what was asked, what was concluded,
 * and what a compaction preserved.
 */
function searchableText(e: FeinEvent): string | undefined {
  if (e.channel !== "main") return undefined;
  switch (e.kind) {
    case "user":
      return e.text;
    case "assistant":
      return e.text.trim() || undefined;
    case "epoch":
      return e.snapshot;
    case "digest":
      return e.text;
    case "system_note":
      return e.text;
    default:
      return undefined;
  }
}

/**
 * FTS5 MATCH is a query language, not a string. Raw user text containing a
 * quote or a bare `AND` is a syntax error, and a syntax error inside a recall
 * tool surfaces to the model as a broken tool rather than "no results". So we
 * reduce to bare terms and OR them.
 */
export function sanitizeFtsQuery(q: string): string {
  const terms = q
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1 && !FTS_STOPWORDS.has(t));
  if (terms.length === 0) return "";
  return terms.map((t) => `"${t}"`).join(" OR ");
}

const FTS_STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "not", "of", "to", "in", "is", "it", "for",
  "on", "with", "as", "at", "by", "we", "i", "you", "that", "this", "was",
  "what", "did", "do", "does", "about", "how",
]);
