import { expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import * as Exit from "effect/Exit";
import { guardedClick } from "./GuardedBrowserClick.ts";

it.effect(
  "warns before measuring and clicking, and waits for notification removal on success and failure",
  () =>
    Effect.gen(function* () {
      for (const fails of [false, true]) {
        const posted = Promise.withResolvers<void>();
        const events: string[] = [];
        const fiber = yield* guardedClick({
          post: async () => {
            events.push("post");
            posted.resolve();
          },
          remove: async () => {
            events.push("remove");
          },
          target: async () => {
            events.push("measure");
            return { x: -120, y: 80 };
          },
          execute: async (point) => {
            events.push("click");
            expect(point).toEqual({ x: -120, y: 80 });
            if (fails) throw new Error("injected click failure");
          },
        }).pipe(Effect.forkChild);
        yield* Effect.promise(() => posted.promise);
        expect(events).toEqual(["post"]);
        yield* TestClock.adjust("5 seconds");
        const result = yield* Fiber.await(fiber);
        expect(Exit.isFailure(result)).toBe(fails);
        expect(events).toEqual(["post", "measure", "click", "remove"]);
      }
    }),
);

it.effect("does not click without a confirmed notification or when target measurement fails", () =>
  Effect.gen(function* () {
    const events: string[] = [];
    const result = yield* guardedClick({
      post: async () => {
        throw new Error("notifications denied");
      },
      remove: async () => {
        events.push("remove");
      },
      target: async () => {
        events.push("measure");
        return { x: 0, y: 0 };
      },
      execute: async () => {
        events.push("click");
      },
    }).pipe(Effect.exit);
    expect(Exit.isFailure(result)).toBe(true);
    expect(events).toEqual([]);
  }),
);
