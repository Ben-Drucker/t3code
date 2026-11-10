// @effect-diagnostics nodeBuiltinImport:off globalTimers:off -- Firefox's startup notification and captured child own the launch lifetime.
import * as Effect from "effect/Effect";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";

import { MarionetteError } from "./MarionetteClient.ts";

export const launch = Effect.fn("FirefoxProcess.launch")(function* (options: {
  readonly executable: string;
  readonly port?: number;
  readonly headless?: boolean;
  readonly bidi?: boolean;
}) {
  const directory = yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: () => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-firefox-")),
      catch: (cause) =>
        new MarionetteError({ code: "profile creation failed", command: "launch", cause }),
    }),
    (path) => Effect.promise(() => NodeFSP.rm(path, { recursive: true, force: true })),
  );
  yield* Effect.tryPromise({
    try: () =>
      NodeFSP.writeFile(
        NodePath.join(directory, "user.js"),
        [
          `user_pref("marionette.port", ${options.port ?? 0});`,
          'user_pref("remote.log.level", "Info");',
          'user_pref("browser.shell.checkDefaultBrowser", false);',
          'user_pref("browser.startup.homepage_override.mstone", "ignore");',
          'user_pref("browser.aboutwelcome.enabled", false);',
          'user_pref("datareporting.policy.dataSubmissionPolicyBypassNotification", true);',
        ].join("\n"),
      ),
    catch: (cause) =>
      new MarionetteError({ code: "profile creation failed", command: "launch", cause }),
  });
  return yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: async () => {
        const child = NodeChildProcess.spawn(
          options.executable,
          [
            "--no-remote",
            "--profile",
            directory,
            "--marionette",
            ...(options.bidi === false ? [] : ["--remote-debugging-port", "0"]),
            ...(options.headless === false ? [] : ["--headless"]),
            "about:blank",
          ],
          { stdio: ["ignore", "pipe", "pipe"] },
        );
        const stop = async () => {
          if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null)
            return;
          const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
          child.kill("SIGTERM");
          const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
          try {
            await exited;
          } finally {
            clearTimeout(timer);
          }
        };
        try {
          const port = await new Promise<number>((resolve, reject) => {
            let output = "";
            const timer = setTimeout(() => finish(new Error("Firefox startup timed out")), 15_000);
            const finish = (cause?: unknown, port?: number) => {
              clearTimeout(timer);
              child.off("error", failed);
              child.off("exit", exited);
              child.stdout.off("data", read);
              child.stderr.off("data", read);
              if (cause) reject(cause);
              else resolve(port!);
            };
            const failed = (cause: Error) => finish(cause);
            const exited = () => finish(new Error("Firefox exited before Marionette was ready"));
            const read = (data: Buffer) => {
              output = (output + data.toString()).slice(-4_000);
              const match = /Marionette\s+INFO\s+Listening on port (\d+)/.exec(output);
              if (match) finish(undefined, Number(match[1]));
            };
            child.on("error", failed);
            child.on("exit", exited);
            child.stdout.on("data", read);
            child.stderr.on("data", read);
          });
          child.stdout.resume();
          child.stderr.resume();
          return { port, stop };
        } catch (cause) {
          await stop();
          throw cause;
        }
      },
      catch: (cause) => new MarionetteError({ code: "launch failed", command: "launch", cause }),
    }),
    (running) => Effect.promise(running.stop),
  );
});
