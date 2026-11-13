import type { ProviderAdapterV2Event } from "@t3tools/provider-core/server/ProviderAdapter";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Queue from "effect/Queue";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

export const CONTEXT_USAGE_UPDATE_INTERVAL_MS = 1000;
const MAX_BUFFERED_PROVIDER_EVENTS = 64;

function snapshot(event: ProviderAdapterV2Event) {
  if (!["claudeAgent", "codex", "opencode", "antigravity", "acpRegistry"].includes(event.driver))
    return undefined;
  if (
    event.type === "provider_turn.updated" &&
    event.providerTurn.status === "running" &&
    event.providerTurn.tokenUsage
  ) {
    const { tokenUsage: _usage, ...rest } = event.providerTurn;
    return {
      key: `turn:${rest.id}`,
      signature: JSON.stringify([rest, _usage.maxTokens, _usage.autoCompactThreshold]),
    };
  }
  if (event.type === "provider_thread.updated" && event.providerThread.contextUsage) {
    const { contextUsage: _usage, updatedAt: _updatedAt, ...rest } = event.providerThread;
    return {
      key: `thread:${rest.id}`,
      signature: JSON.stringify([rest, _usage.maxTokens, _usage.autoCompactThreshold]),
    };
  }
  return undefined;
}

export const throttleContextUsage = <E, R>(source: Stream.Stream<ProviderAdapterV2Event, E, R>) =>
  Stream.unwrap(
    Effect.gen(function* () {
      const output = yield* Queue.bounded<ProviderAdapterV2Event, E | Cause.Done>(
        MAX_BUFFERED_PROVIDER_EVENTS,
      );
      const mutex = yield* Semaphore.make(1);
      const windows = new Map<
        string,
        { signature: string; pending: ProviderAdapterV2Event | undefined }
      >();
      const flush = Effect.gen(function* () {
        for (const window of windows.values()) {
          if (window.pending) yield* Queue.offer(output, window.pending);
        }
        windows.clear();
      });
      const scope = yield* Effect.scope;
      yield* source.pipe(
        Stream.runForEach((event) =>
          mutex.withPermits(1)(
            Effect.gen(function* () {
              const next = snapshot(event);
              const window = next && windows.get(next.key);
              if (next && window?.signature === next.signature) {
                window.pending = event;
                return;
              }
              // Whole-entity changes and lifecycle events must never be reordered behind usage.
              const boundary =
                event.type === "turn.terminal" ||
                event.type === "provider_session.updated" ||
                (!next &&
                  (event.type === "provider_thread.updated" ||
                    event.type === "provider_turn.updated")) ||
                (event.type === "provider_turn.updated" &&
                  event.providerTurn.status !== "running") ||
                (event.type === "turn_item.updated" && event.turnItem.type === "compaction");
              if (boundary || window) yield* flush;
              yield* Queue.offer(output, event);
              if (next) {
                const current = {
                  signature: next.signature,
                  pending: undefined as ProviderAdapterV2Event | undefined,
                };
                windows.set(next.key, current);
                yield* Effect.gen(function* () {
                  while (true) {
                    yield* Effect.sleep(CONTEXT_USAGE_UPDATE_INTERVAL_MS);
                    const again = yield* mutex.withPermits(1)(
                      Effect.gen(function* () {
                        if (windows.get(next.key) !== current) return false;
                        if (!current.pending) {
                          windows.delete(next.key);
                          return false;
                        }
                        yield* Queue.offer(output, current.pending);
                        current.pending = undefined;
                        return true;
                      }),
                    );
                    if (!again) return;
                  }
                }).pipe(Effect.forkIn(scope));
              }
            }),
          ),
        ),
        Effect.exit,
        Effect.flatMap((exit) =>
          mutex.withPermits(1)(
            Effect.gen(function* () {
              yield* flush;
              if (Exit.isFailure(exit)) yield* Queue.failCause(output, exit.cause);
              else yield* Queue.end(output);
            }),
          ),
        ),
        Effect.forkScoped({ startImmediately: true }),
      );
      return Stream.fromQueue(output);
    }),
  );
