import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  makeKimiContextUsageReader,
  parseKimiModelWindows,
  parseKimiWireTail,
} from "./kimiSession.ts";

const line = (record: unknown) => JSON.stringify(record);

describe("parseKimiWireTail", () => {
  it("takes the newest context size and model alias, ignoring garbage", () => {
    expect(
      parseKimiWireTail([
        line({ type: "llm.request", modelAlias: "kimi-code/old" }),
        line({ type: "token_counting.measured", tokens: 1200 }),
        "not json",
        line({ type: "llm.request", modelAlias: "kimi-code/kimi-for-coding" }),
        line({ type: "usage.record", usage: { output: 5 } }),
        line({ type: "token_counting.measured", tokens: 3400 }),
        line({ type: "agent.turn.ended" }),
      ]),
    ).toEqual({ usedTokens: 3400, modelAlias: "kimi-code/kimi-for-coding" });
  });

  it("counts the turn summary as a context size too", () => {
    expect(parseKimiWireTail([line({ type: "token_counting.turn_recorded", tokens: 90 })])).toEqual(
      { usedTokens: 90 },
    );
    expect(parseKimiWireTail([])).toEqual({});
  });
});

describe("parseKimiModelWindows", () => {
  it("reads max_context_size per model section", () => {
    const windows = parseKimiModelWindows(
      [
        'default_model = "kimi-code/kimi-for-coding"',
        "",
        '[models."kimi-code/kimi-for-coding"]',
        'provider = "managed:kimi-code"',
        "max_context_size = 1048576",
        "",
        '[models."kimi-code/k3-256k"]',
        "max_context_size = 262144 # tokens",
        "",
        "[providers.other]",
        "max_context_size = 5",
      ].join("\n"),
    );
    expect(windows.get("kimi-code/kimi-for-coding")).toBe(1048576);
    expect(windows.get("kimi-code/k3-256k")).toBe(262144);
    expect(windows.size).toBe(2);
  });

  it("prefers a model's overrides table, which the CLI keeps when it refreshes models", () => {
    const windows = parseKimiModelWindows(
      [
        '[models."kimi-code/k3"]',
        "max_context_size = 1048576",
        "",
        '[models."kimi-code/k3".overrides]',
        "max_context_size = 375000",
        "",
        '[models."kimi-code/k3-256k"]',
        "max_context_size = 262144",
      ].join("\n"),
    );
    expect(windows.get("kimi-code/k3")).toBe(375000);
    expect(windows.get("kimi-code/k3-256k")).toBe(262144);
  });
});

describe("makeKimiContextUsageReader", () => {
  it.effect("finds the session folder, follows new steps and reads the window from config", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-kimi-session-" });
      const share = path.join(home, ".kimi-code");
      const mainDirectory = path.join(
        share,
        "sessions",
        "wd_proj_abc",
        "session_1234",
        "agents",
        "main",
      );
      yield* fs.makeDirectory(mainDirectory, { recursive: true });
      yield* fs.writeFileString(
        path.join(share, "config.toml"),
        '[models."kimi-code/kimi-for-coding"]\nmax_context_size = 262144\n',
      );
      // macOS leaves stray files next to the buckets; they must not break the lookup.
      yield* fs.writeFileString(path.join(share, "sessions", ".DS_Store"), "x");
      const wirePath = path.join(mainDirectory, "wire.jsonl");
      yield* fs.writeFileString(
        wirePath,
        `${line({ type: "llm.request", modelAlias: "kimi-code/kimi-for-coding" })}\n${line({ type: "token_counting.measured", tokens: 100 })}\n`,
      );
      const read = makeKimiContextUsageReader({
        fs,
        path,
        environment: {},
        homeDirectory: home,
      });
      expect(yield* read({ sessionId: "1234" })).toEqual({ usedTokens: 100, maxTokens: 262144 });
      expect(yield* read({ sessionId: "session_1234" })).toEqual({
        usedTokens: 100,
        maxTokens: 262144,
      });
      yield* fs.writeFileString(
        wirePath,
        `${line({ type: "token_counting.measured", tokens: 100 })}\n${line({ type: "token_counting.measured", tokens: 450 })}\n`,
      );
      // A poll whose tail names no model still reports usage.
      expect((yield* read({ sessionId: "1234" }))?.usedTokens).toBe(450);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("falls back to the newest session when the id names no folder", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-kimi-fallback-" });
      const sessionsRoot = path.join(home, ".kimi-code", "sessions", "wd_proj_abc");
      for (const [name, tokens, time] of [
        ["session_old", 10, 1_000],
        ["session_new", 20, 2_000],
      ] as const) {
        const directory = path.join(sessionsRoot, name, "agents", "main");
        yield* fs.makeDirectory(directory, { recursive: true });
        const wirePath = path.join(directory, "wire.jsonl");
        yield* fs.writeFileString(
          wirePath,
          `${line({ type: "token_counting.measured", tokens })}\n`,
        );
        yield* fs.utimes(wirePath, time, time);
      }
      const read = makeKimiContextUsageReader({ fs, path, environment: {}, homeDirectory: home });
      expect(yield* read({ sessionId: "acp-id-that-names-nothing" })).toEqual({ usedTokens: 20 });
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
