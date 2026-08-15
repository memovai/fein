import { randomUUID } from "node:crypto";
import type { ChannelId, FeinEvent, Reasoning, ToolCall, ToolResult } from "./types.js";

/**
 * The Transcript is FE!N's single source of truth: an append-only event log.
 *
 * Invariants (enforced here, relied on everywhere):
 *  1. Events are never mutated or removed. Corrections are new events.
 *  2. Events are totally ordered by append order (ts is informative only).
 *  3. Views (lenses) may filter and transform, but any binding's rendered
 *     prompt must be a pure function of a *prefix* of this log — that is what
 *     makes provider KV caches hit across turns and across model swaps.
 */
export class Transcript {
  private events: FeinEvent[] = [];
  private listeners: Array<(e: FeinEvent) => void> = [];

  get all(): readonly FeinEvent[] {
    return this.events;
  }

  channel(id: ChannelId): FeinEvent[] {
    return this.events.filter((e) => e.channel === id);
  }

  onAppend(fn: (e: FeinEvent) => void): void {
    this.listeners.push(fn);
  }

  private append<E extends FeinEvent>(e: E): E {
    this.events.push(e);
    for (const fn of this.listeners) fn(e);
    return e;
  }

  /**
   * Load prior events without notifying listeners.
   *
   * Replay is not the same act as occurrence. A resumed session must not
   * re-fire persistence sinks, hooks, or notifications for history that
   * already happened — otherwise resuming a session duplicates every row it
   * writes and re-runs every side effect it triggered.
   */
  hydrate(events: readonly FeinEvent[]): void {
    this.events.push(...events);
  }

  user(text: string, channel: ChannelId = "main"): FeinEvent {
    return this.append({ kind: "user", id: randomUUID(), ts: Date.now(), channel, text });
  }

  assistant(
    text: string,
    toolCalls: ToolCall[],
    by: string,
    channel: ChannelId = "main",
    reasoning?: Reasoning[],
  ): FeinEvent {
    return this.append({
      kind: "assistant",
      id: randomUUID(),
      ts: Date.now(),
      channel,
      text,
      toolCalls,
      ...(reasoning?.length ? { reasoning } : {}),
      by,
    });
  }

  toolResult(result: ToolResult, channel: ChannelId = "main"): FeinEvent {
    return this.append({ kind: "tool_result", id: randomUUID(), ts: Date.now(), channel, result });
  }

  digest(ofEventId: string, text: string, by: string, channel: ChannelId = "main"): FeinEvent {
    return this.append({
      kind: "digest",
      id: randomUUID(),
      ts: Date.now(),
      channel,
      ofEventId,
      text,
      by,
    });
  }

  spill(
    ofEventId: string,
    preview: string,
    path: string,
    originalBytes: number,
    channel: ChannelId = "main",
  ): FeinEvent {
    return this.append({
      kind: "spill",
      id: randomUUID(),
      ts: Date.now(),
      channel,
      ofEventId,
      preview,
      path,
      originalBytes,
    });
  }

  epoch(reason: string, snapshot: string, channel: ChannelId = "main"): FeinEvent {
    return this.append({
      kind: "epoch",
      id: randomUUID(),
      ts: Date.now(),
      channel,
      reason,
      snapshot,
    });
  }

  note(text: string, by: string, channel: ChannelId = "main"): FeinEvent {
    return this.append({ kind: "note", id: randomUUID(), ts: Date.now(), channel, text, by });
  }

  /** Operator context, appended — never an edit to the top-level system prompt. */
  systemNote(text: string, channel: ChannelId = "main"): FeinEvent {
    return this.append({ kind: "system_note", id: randomUUID(), ts: Date.now(), channel, text });
  }

  toolChange(op: "add" | "remove", tool: string, channel: ChannelId = "main"): FeinEvent {
    return this.append({
      kind: "tool_change",
      id: randomUUID(),
      ts: Date.now(),
      channel,
      op,
      tool,
    });
  }

  /** Allocate a fresh side channel for delegated work. */
  newSideChannel(label: string): ChannelId {
    return `side:${label}:${randomUUID().slice(0, 8)}`;
  }

  toJSON(): FeinEvent[] {
    return [...this.events];
  }
}
