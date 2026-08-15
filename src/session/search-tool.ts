import type { Tool } from "../tools/registry.js";
import type { SessionStore } from "./store.js";

/**
 * `session_search` — model-facing recall across every prior session.
 *
 * The alternative designs are both worse. Loading past sessions into context
 * up front burns tokens on material that is usually irrelevant and shifts the
 * cached prefix every time memory changes. Auto-injecting "relevant memories"
 * behind the model's back makes its behavior depend on a retrieval heuristic
 * nobody can see or debug.
 *
 * A tool puts the decision where the reasoning is: the model knows when it is
 * missing prior context, asks for it, and the result lands as an ordinary tool
 * result — appended, cache-safe, and visible in the transcript.
 *
 * Results are deliberately short. This is a pointer into history, not history:
 * each hit carries enough to decide whether to pull the whole session, and no
 * more.
 */
export function sessionSearchTool(
  store: SessionStore,
  currentSessionId?: () => string | undefined,
): Tool {
  return {
    spec: {
      name: "session_search",
      description:
        "Search your own memory of previous sessions with this user. Use it when the task " +
        "references earlier work ('like we did last time', 'the usual setup'), when you need a " +
        "decision or preference you do not have in context, or before re-deriving something " +
        "that was probably settled before. Returns short excerpts, not whole conversations.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Keywords describing what to recall. Plain words, not a question.",
          },
          limit: { type: "integer", description: "Max results, default 8." },
        },
        required: ["query"],
      },
    },
    async run(args) {
      const query = String(args["query"] ?? "");
      const limit = Math.min(Number(args["limit"] ?? 8) || 8, 25);
      const exclude = currentSessionId?.();
      const hits = store.search(query, {
        limit,
        ...(exclude ? { excludeSession: exclude } : {}),
      });

      if (hits.length === 0) {
        return `No prior sessions mention "${query}". This appears to be new ground.`;
      }

      return hits
        .map((h) => {
          const when = new Date(h.ts).toISOString().slice(0, 16).replace("T", " ");
          const where = h.sessionTitle ? `${h.sessionTitle} (${h.sessionId})` : h.sessionId;
          const excerpt = h.text.length > 400 ? `${h.text.slice(0, 397)}...` : h.text;
          return `[${when}] ${where} · ${h.kind}\n${excerpt}`;
        })
        .join("\n\n---\n\n");
    },
  };
}

/**
 * `session_lineage` — read the compaction ancestry of the current session.
 *
 * This exists because of a specific failure the epoch strategy creates: after
 * a compaction the model is working from a summary, and it has no way to know
 * what the summary dropped. Without this it either trusts the summary blindly
 * or re-derives things it already knew. With it, "check what the earlier
 * session actually said" is one tool call.
 */
export function sessionLineageTool(store: SessionStore, currentSessionId: () => string): Tool {
  return {
    spec: {
      name: "session_lineage",
      description:
        "Show the compaction history of this session. Use it when working from a summary and " +
        "you need to know what detail was compacted away, or to confirm whether something was " +
        "already decided before the last compaction.",
      parameters: { type: "object", properties: {} },
    },
    async run() {
      const chain = store.lineage(currentSessionId());
      if (chain.length <= 1) {
        return "This session has not been compacted; nothing has been summarized away.";
      }
      return chain
        .map((s, i) => {
          const when = new Date(s.createdAt).toISOString().slice(0, 16).replace("T", " ");
          const label = i === 0 ? "current" : `${i} generation(s) back`;
          const reason = s.meta["epochReason"];
          return (
            `${s.id} — ${label}, gen ${s.generation}, started ${when}, ` +
            `${store.eventCount(s.id)} events` +
            (reason ? `\n  compacted because: ${String(reason)}` : "")
          );
        })
        .join("\n");
    },
  };
}
