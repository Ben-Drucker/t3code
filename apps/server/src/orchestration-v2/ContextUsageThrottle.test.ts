import { assert, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ThreadId,
} from "@t3tools/contracts";
import type { ProviderAdapterV2Event } from "@t3tools/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import { CONTEXT_USAGE_UPDATE_INTERVAL_MS, throttleContextUsage } from "./ContextUsageThrottle.ts";

const usage = (usedTokens: number): ProviderAdapterV2Event => ({
  type: "provider_thread.updated",
  driver: ProviderDriverKind.make("antigravity"),
  providerThread: {
    id: ProviderThreadId.make("p"),
    driver: ProviderDriverKind.make("antigravity"),
    providerInstanceId: ProviderInstanceId.make("i"),
    providerSessionId: ProviderSessionId.make("s"),
    appThreadId: ThreadId.make("t"),
    ownerNodeId: null,
    nativeThreadRef: null,
    nativeConversationHeadRef: null,
    status: "idle",
    firstRunOrdinal: null,
    lastRunOrdinal: null,
    handoffIds: [],
    forkedFrom: null,
    createdAt: DateTime.makeUnsafe(0),
    updatedAt: DateTime.makeUnsafe(usedTokens),
    contextUsage: { usedTokens, maxTokens: 256000 },
  },
});

it.effect("flushes the newest usage when the provider stream ends", () =>
  Effect.gen(function* () {
    const events = yield* Stream.make(usage(100), usage(200), usage(300)).pipe(
      throttleContextUsage,
      Stream.runCollect,
    );
    assert.deepEqual(events, [usage(100), usage(300)]);
  }),
);

it.effect("coalesces to the latest sample and flushes lifecycle boundaries", () =>
  Effect.gen(function* () {
    const input = yield* Queue.unbounded<ProviderAdapterV2Event>();
    const output = yield* Queue.unbounded<ProviderAdapterV2Event>();
    yield* Stream.fromQueue(input).pipe(
      throttleContextUsage,
      Stream.runForEach((event) => Queue.offer(output, event)),
      Effect.forkScoped,
    );
    yield* Queue.offer(input, usage(100));
    assert.deepEqual(yield* Queue.take(output), usage(100));
    yield* Queue.offerAll(input, [usage(200), usage(300)]);
    yield* TestClock.adjust(CONTEXT_USAGE_UPDATE_INTERVAL_MS);
    assert.deepEqual(yield* Queue.take(output), usage(300));
    yield* Queue.offerAll(input, [usage(400), usage(500)]);
    const terminal = usage(500);
    if (terminal.type !== "provider_thread.updated") throw new Error("fixture");
    const stopped = {
      ...terminal,
      providerThread: { ...terminal.providerThread, status: "closed" as const },
    };
    yield* Queue.offer(input, stopped);
    assert.deepEqual(yield* Queue.take(output), usage(500));
    assert.deepEqual(yield* Queue.take(output), stopped);
  }).pipe(Effect.scoped),
);
