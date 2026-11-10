// @effect-diagnostics nodeBuiltinImport:off -- Compiles and exercises pure native argument/restore planning, never OS events.
import { expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as NodeFSP from "node:fs/promises";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";

const exec = NodeUtil.promisify(NodeChildProcess.execFile);
// oxlint-disable-next-line t3code/no-global-process-runtime -- Native toolchain availability is determined before registering the conditional test.
const available = NodeOS.platform() === "darwin" && NodeFS.existsSync("/usr/bin/swiftc");
it.live.runIf(available)(
  "restores native window order and cursor and rejects malformed notification/helper arguments without OS input",
  () =>
    Effect.gen(function* () {
      const dir = yield* Effect.acquireRelease(
        Effect.promise(() =>
          NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-native-click-test-")),
        ),
        (dir) => Effect.promise(() => NodeFSP.rm(dir, { force: true, recursive: true })),
      );
      const binary = NodePath.join(dir, "helper");
      yield* Effect.promise(() =>
        exec("swiftc", [
          "-O",
          "-module-cache-path",
          NodePath.join(dir, "module-cache"),
          new URL("../../../../native/browser-click/main.swift", import.meta.url).pathname,
          "-o",
          binary,
        ]),
      );
      const before = [1, 2, 3, 4].map((id) => ({ id, pid: id * 10 }));
      for (const [after, expected] of [
        [
          [4, 1, 3, 5],
          [4, 3, 1],
        ],
        [[1, 2, 3, 4], []],
        [[], []],
      ] as const) {
        const input = {
          before,
          after: after.map((id) => ({ id, pid: id * 10 })),
          cursor: { x: -1200, y: 250 },
        };
        const result = yield* Effect.promise(() => exec(binary, ["plan", JSON.stringify(input)]));
        expect(JSON.parse(result.stdout)).toEqual({
          windows: expected.map((id) => ({ id, pid: id * 10 })),
          cursor: input.cursor,
        });
      }
      for (const args of [
        [],
        ["post"],
        ["remove"],
        ["click"],
        ["post", "../escape", "title", "body"],
        ["remove", "bad\nid"],
      ]) {
        const result = yield* Effect.promise(() =>
          exec(binary, args).then(
            () => "unexpected success",
            () => "rejected",
          ),
        );
        expect(result).toBe("rejected");
      }
    }),
);
