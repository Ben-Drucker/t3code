import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { makeKimiContextUsageReader, parseKimiContextUsage } from "./kimiSession.ts";

const contextLine = (record: unknown) => JSON.stringify(record);

describe("parseKimiContextUsage", () => {
  it("takes the newest _usage line and the window from the status event", () => {
    expect(
      parseKimiContextUsage({
        contextLines: [
          contextLine({ role: "user", content: "hi" }),
          contextLine({ role: "_usage", token_count: 1200 }),
          contextLine({ role: "assistant", content: "ok" }),
          contextLine({ role: "_usage", token_count: 3400 }),
          contextLine({ role: "_checkpoint", id: 2 }),
        ],
        wireLines: [
          contextLine({ type: "metadata", protocol_version: "1.0" }),
          contextLine({
            timestamp: 1,
            message: {
              type: "StatusUpdate",
              payload: { context_tokens: 3000, max_context_tokens: 262144, context_usage: 0.01 },
            },
          }),
        ],
      }),
    ).toEqual({ usedTokens: 3400, maxTokens: 262144 });
  });

  it("falls back to the status event's own token count and tolerates garbage", () => {
    expect(
      parseKimiContextUsage({
        contextLines: ["not json", contextLine({ role: "user" })],
        wireLines: [
          "{broken",
          contextLine({ message: { context_tokens: 900, max_context_tokens: 1000 } }),
        ],
      }),
    ).toEqual({ usedTokens: 900, maxTokens: 1000 });
    expect(parseKimiContextUsage({ contextLines: [], wireLines: [] })).toBeUndefined();
  });

  it("reports tokens without a window when none was recorded", () => {
    expect(
      parseKimiContextUsage({
        contextLines: [contextLine({ role: "_usage", token_count: 50 })],
        wireLines: [],
      }),
    ).toEqual({ usedTokens: 50 });
  });
});

describe("makeKimiContextUsageReader", () => {
  it.effect("finds the session under any bucket and follows appended steps", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-kimi-session-" });
      const sessionDirectory = path.join(home, ".kimi", "sessions", "abc123bucket", "session-1");
      yield* fs.makeDirectory(sessionDirectory, { recursive: true });
      const contextPath = path.join(sessionDirectory, "context.jsonl");
      yield* fs.writeFileString(
        contextPath,
        `${contextLine({ role: "_usage", token_count: 100 })}\n`,
      );
      yield* fs.writeFileString(
        path.join(sessionDirectory, "wire.jsonl"),
        `${contextLine({ message: { max_context_tokens: 200000 } })}\n`,
      );
      const read = makeKimiContextUsageReader({
        fs,
        path,
        environment: {},
        homeDirectory: home,
      });
      expect(yield* read({ sessionId: "session-1" })).toEqual({
        usedTokens: 100,
        maxTokens: 200000,
      });
      yield* fs.writeFileString(
        contextPath,
        `${contextLine({ role: "_usage", token_count: 100 })}\n${contextLine({ role: "_usage", token_count: 450 })}\n`,
      );
      expect((yield* read({ sessionId: "session-1" }))?.usedTokens).toBe(450);
      expect(yield* read({ sessionId: "unknown-session" })).toBeUndefined();
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("returns nothing when Kimi has no sessions directory", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-kimi-empty-" });
      const read = makeKimiContextUsageReader({ fs, path, environment: {}, homeDirectory: home });
      expect(yield* read({ sessionId: "s" })).toBeUndefined();
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
