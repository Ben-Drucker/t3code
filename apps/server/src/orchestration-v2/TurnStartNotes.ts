import type { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

interface PendingNote {
  readonly render: () => string;
  readonly onDelivered?: () => void;
}

/**
 * Notes for the agent that wait for the user's next prompt on a thread. Held in memory: the work
 * they describe ends with the server, and a restart has its own note.
 */
export class TurnStartNotes extends Context.Service<
  TurnStartNotes,
  {
    /** Replaces any note under the same key; render runs when the note is delivered. */
    readonly put: (
      threadId: ThreadId,
      key: string,
      render: () => string,
      onDelivered?: () => void,
    ) => Effect.Effect<void>;
    readonly take: (threadId: ThreadId) => Effect.Effect<string>;
  }
>()("t3/orchestration-v2/TurnStartNotes") {}

export const layer = Layer.sync(TurnStartNotes, () => {
  const notes = new Map<ThreadId, Map<string, PendingNote>>();
  return TurnStartNotes.of({
    put: Effect.fn("TurnStartNotes.put")(function* (threadId, key, render, onDelivered) {
      yield* Effect.sync(() => {
        const byKey = notes.get(threadId) ?? new Map<string, PendingNote>();
        byKey.set(key, onDelivered === undefined ? { render } : { render, onDelivered });
        notes.set(threadId, byKey);
      });
    }),
    take: Effect.fn("TurnStartNotes.take")(function* (threadId) {
      return yield* Effect.sync(() => {
        const byKey = notes.get(threadId);
        if (byKey === undefined) return "";
        notes.delete(threadId);
        const pending = [...byKey.values()];
        const text = pending
          .map((note) => note.render())
          .filter((part) => part !== "")
          .join("\n\n");
        for (const note of pending) note.onDelivered?.();
        return text;
      });
    }),
  });
});
