/**
 * Steering: sending the agent a message while it is already working.
 *
 * The situation this exists for is the most common one in interactive use and
 * FE!N had no answer for it. The agent is six turns into a task, you can see it
 * is exploring the wrong directory, and you want to say so. Today your options
 * are to wait for it to finish being wrong, or to kill the run and lose the
 * context it built. Neither is what you want; you want to *redirect* it.
 *
 * ## Why a queue rather than just calling run() again
 *
 * Because a second concurrent `run()` would race the first on the transcript,
 * and the transcript is the one thing in this harness that must never be raced.
 * Two writers interleaving events produce a message order that depends on
 * scheduling — which breaks prefix monotonicity, and therefore the cache, in a
 * way that is intermittent and effectively undebuggable.
 *
 * So steering is not a second conversation. It is a message deposited for the
 * *existing* one, drained by the loop at a point it chooses.
 *
 * ## Why only at a turn boundary
 *
 * A turn is Thought → Action → Observation. Injecting between the Action and the
 * Observation would hand the model a user message where it is expecting a tool
 * result, which every provider rejects and which would be an incoherent thing to
 * say anyway — the model asked a question and deserves its answer before being
 * given new instructions.
 *
 * Draining at the boundary means a steer appends cleanly after a completed
 * cycle. The prefix grows; nothing is rewritten; the cache survives.
 *
 * The cost is latency: a steer sent during a slow tool call waits for that call
 * to finish. That is the correct trade — the alternative is a corrupt
 * transcript, and "your correction applied one turn later than you typed it" is
 * a far smaller problem than "the conversation is now unreplayable".
 */

export interface Steer {
  text: string;
  queuedAt: number;
}

export class SteeringQueue {
  private pending: Steer[] = [];
  private closed = false;

  /**
   * Queue a message for the next turn boundary.
   *
   * Returns the queue depth so a caller can tell the user whether their message
   * is about to land or is sitting behind others — the difference between
   * "sent" and "queued" is worth surfacing when a turn might take a minute.
   */
  push(text: string): number {
    const body = text.trim();
    if (!body || this.closed) return this.pending.length;
    this.pending.push({ text: body, queuedAt: Date.now() });
    return this.pending.length;
  }

  get depth(): number {
    return this.pending.length;
  }

  /**
   * Take everything queued.
   *
   * All of it at once, not one per turn. Someone who types three corrections
   * while the agent works meant all three; delivering them across three turns
   * would let the agent act on the first before seeing that the second
   * retracted it.
   */
  drain(): Steer[] {
    const out = this.pending;
    this.pending = [];
    return out;
  }

  /** Stop accepting messages. Anything already queued still drains. */
  close(): void {
    this.closed = true;
  }
}

/**
 * Render queued steers as one user message.
 *
 * Framed so the model understands *when* it arrived. Without that framing a
 * mid-task instruction reads as though it were part of the original request,
 * and the model tries to reconcile it with work it has already done rather than
 * treating it as a correction to what it is doing now.
 */
export function formatSteers(steers: Steer[]): string {
  if (steers.length === 1) {
    return `[The user sent this while you were working — treat it as a correction to your current approach, not as a new task.]\n\n${steers[0]!.text}`;
  }
  return [
    "[The user sent these while you were working, in this order. Treat them as corrections",
    "to your current approach, and note that a later one may retract an earlier one.]",
    "",
    ...steers.map((s, i) => `${i + 1}. ${s.text}`),
  ].join("\n");
}
