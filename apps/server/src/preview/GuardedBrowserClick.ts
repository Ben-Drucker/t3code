// @effect-diagnostics nodeBuiltinImport:off -- Native helper compilation and invocation are the host boundary.
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeUtil from "node:util";
import * as NodeCrypto from "node:crypto";
import { notificationArguments, type Point } from "./FirefoxAutofillGeometry.ts";

export class GuardedClickError extends Schema.TaggedError<GuardedClickError>()(
  "GuardedClickError",
  {
    stage: Schema.Literals(["unsupported", "build", "notification", "click", "restore"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message() {
    return `Firefox autofill OS click failed (${this.stage}). Check Notification Center and Device Control and Data Access permissions for T3 Code.`;
  }
}

export class GuardedBrowserClick extends Context.Service<
  GuardedBrowserClick,
  {
    readonly supported: boolean;
    readonly click: (
      pid: number,
      target: () => Promise<Point>,
    ) => Effect.Effect<void, GuardedClickError>;
  }
>()("t3/preview/GuardedBrowserClick") {}

const exec = NodeUtil.promisify(NodeChildProcess.execFile);
export const guardedClick = Effect.fn("GuardedBrowserClick.guardedClick")(function* (input: {
  readonly post: () => Promise<void>;
  readonly remove: () => Promise<void>;
  readonly target: () => Promise<Point>;
  readonly execute: (point: Point) => Promise<void>;
}) {
  yield* Effect.acquireUseRelease(
    Effect.tryPromise({
      try: input.post,
      catch: (cause) => new GuardedClickError({ stage: "notification", cause }),
    }),
    () =>
      Effect.gen(function* () {
        yield* Effect.sleep("5 seconds");
        yield* Effect.tryPromise({
          try: async () => {
            const point = await input.target();
            if (!Number.isFinite(point.x) || !Number.isFinite(point.y))
              throw new Error("Invalid click point");
            await input.execute(point);
          },
          catch: (cause) => new GuardedClickError({ stage: "click", cause }),
        });
      }),
    () =>
      Effect.tryPromise({
        try: input.remove,
        catch: (cause) => new GuardedClickError({ stage: "notification", cause }),
      }).pipe(Effect.orDie),
  );
});
const make = Effect.gen(function* () {
  const platform = yield* HostProcess.Platform;
  const cwd = yield* HostProcess.WorkingDirectory;
  const executable = yield* HostProcess.ExecutablePath;
  const env = yield* HostProcess.Environment;
  const packaged = NodePath.resolve(
    NodePath.dirname(executable),
    "../Resources/browser-click/T3Notify.app",
  );
  const sourceAtRoot = NodePath.resolve(cwd, "native/browser-click");
  const source = (yield* Effect.promise(() =>
    NodeFSP.access(sourceAtRoot).then(
      () => true,
      () => false,
    ),
  ))
    ? sourceAtRoot
    : NodePath.resolve(cwd, "../../native/browser-click");
  const hasPackaged = yield* Effect.promise(() =>
    NodeFSP.access(packaged).then(
      () => true,
      () => false,
    ),
  );
  const app =
    env.T3CODE_BROWSER_CLICK_APP ??
    (hasPackaged ? packaged : NodePath.join(source, "build/T3Notify.app"));
  let built: Promise<void> | undefined;
  const ensureBuilt = () =>
    (built ??= NodeFSP.access(NodePath.join(app, "Contents/MacOS/notify"))
      .catch(async () => {
        await exec("/bin/sh", [NodePath.join(source, "build.sh"), app], { timeout: 90_000 });
      })
      .then(async () => {
        await exec(
          "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister",
          ["-f", app],
          { timeout: 10_000 },
        );
      }));
  const notify = async (args: string[]) => {
    const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-click-notice-"));
    try {
      const output = NodePath.join(dir, "result");
      await exec("/usr/bin/open", ["-W", "-n", "--stdout", output, "-a", app, "--args", ...args], {
        timeout: 20_000,
      });
      const result = await NodeFSP.readFile(output, "utf8");
      if (!result.includes(args[0] === "post" ? "posted" : "removed"))
        throw new Error("Notification helper did not confirm completion.");
    } finally {
      await NodeFSP.rm(dir, { force: true, recursive: true });
    }
  };
  return GuardedBrowserClick.of({
    supported: platform === "darwin",
    click: Effect.fn("GuardedBrowserClick.click")(function* (pid, target) {
      if (platform !== "darwin") return yield* new GuardedClickError({ stage: "unsupported" });
      if (!Number.isInteger(pid) || pid <= 0)
        return yield* new GuardedClickError({ stage: "click" });
      yield* Effect.tryPromise({
        try: ensureBuilt,
        catch: (cause) => new GuardedClickError({ stage: "build", cause }),
      });
      const id = NodeCrypto.randomUUID();
      yield* guardedClick({
        post: () => notify(notificationArguments("post", id)),
        remove: () => notify(notificationArguments("remove", id)),
        target,
        execute: async (point) => {
          const { stdout } = await exec(
            NodePath.join(app, "Contents/MacOS/notify"),
            ["click", String(pid), String(point.x), String(point.y)],
            { timeout: 15_000 },
          );
          if (!stdout.includes("restored"))
            throw new Error("Could not restore desktop after click");
        },
      });
    }),
  });
});
export const layer = Layer.effect(GuardedBrowserClick, make);
