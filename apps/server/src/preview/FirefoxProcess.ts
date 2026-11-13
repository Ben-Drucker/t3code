// @effect-diagnostics nodeBuiltinImport:off globalTimers:off -- Firefox's startup notification and captured child own the launch lifetime.
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { MarionetteError } from "./MarionetteClient.ts";
import { processAlive } from "./ServerBrowserDockedChrome.ts";

const isMarionetteError = Schema.is(MarionetteError);

export const DOCKED_FIREFOX_PROFILE_NAME = "firefox-docked";

export interface FirefoxLaunchOptions {
  readonly executable: string;
  readonly profileDir?: string;
  readonly port?: number;
  readonly headless?: boolean;
  readonly bidi?: boolean;
  readonly bidiPort?: number;
  readonly allowSystemAccess?: boolean;
}

export interface StartedFirefoxProcess {
  readonly port: number;
  readonly pid: number;
  readonly profileDir: string;
  readonly stop: () => Promise<void>;
  readonly exited: Promise<void>;
}

/** Firefox's Unix profile `lock` symlink target ends with `:+<pid>` (for example `127.0.0.1:+48291`). */
export const parseFirefoxLockTarget = (target: string): number | null => {
  const match = /:\+(\d+)$/.exec(target.trim());
  if (!match) return null;
  const pid = Number(match[1]);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
};

export const readFirefoxProfileOwnerPid = async (profileDir: string): Promise<number | null> => {
  const target = await NodeFSP.readlink(NodePath.join(profileDir, "lock")).catch(() => null);
  return target === null ? null : parseFirefoxLockTarget(target);
};

export const buildFirefoxLaunchArgs = (
  directory: string,
  options: Omit<FirefoxLaunchOptions, "executable" | "profileDir">,
): ReadonlyArray<string> => [
  "--no-remote",
  "--profile",
  directory,
  "--marionette",
  ...(options.bidi === false ? [] : ["--remote-debugging-port", String(options.bidiPort ?? 0)]),
  ...(options.allowSystemAccess ? ["--remote-allow-system-access"] : []),
  ...(options.headless === false ? [] : ["--headless"]),
  "about:blank",
];

const writeFirefoxUserPrefs = (directory: string, port: number | undefined) =>
  NodeFSP.writeFile(
    NodePath.join(directory, "user.js"),
    [
      `user_pref("marionette.port", ${port ?? 0});`,
      'user_pref("remote.log.level", "Info");',
      'user_pref("browser.shell.checkDefaultBrowser", false);',
      'user_pref("browser.startup.homepage_override.mstone", "ignore");',
      'user_pref("browser.aboutwelcome.enabled", false);',
      'user_pref("datareporting.policy.dataSubmissionPolicyBypassNotification", true);',
      'user_pref("browser.sessionstore.resume_from_crash", false);',
      'user_pref("toolkit.startup.max_resumed_crashes", -1);',
    ].join("\n"),
  );

export const start = async (options: FirefoxLaunchOptions): Promise<StartedFirefoxProcess> => {
  const temporaryProfile = options.profileDir === undefined;
  const directory = temporaryProfile
    ? await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-firefox-")).catch((cause) => {
        throw new MarionetteError({ code: "profile creation failed", command: "launch", cause });
      })
    : options.profileDir;

  try {
    if (!temporaryProfile) {
      await NodeFSP.mkdir(directory, { recursive: true });
      const owner = await readFirefoxProfileOwnerPid(directory);
      if (owner !== null) {
        if (processAlive(owner)) {
          throw new Error(
            "Firefox is already open with T3's browser profile. Quit that Firefox window and try again.",
          );
        }
        await NodeFSP.rm(NodePath.join(directory, "lock"), { force: true });
      }
    }
    await writeFirefoxUserPrefs(directory, options.port);
  } catch (cause) {
    if (temporaryProfile) {
      await NodeFSP.rm(directory, { recursive: true, force: true }).catch(() => undefined);
    }
    if (isMarionetteError(cause)) throw cause;
    throw new MarionetteError({ code: "profile creation failed", command: "launch", cause });
  }

  try {
    const child = NodeChildProcess.spawn(
      options.executable,
      buildFirefoxLaunchArgs(directory, options),
      {
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          ...(options.allowSystemAccess ? { MOZ_REMOTE_ALLOW_SYSTEM_ACCESS: "1" } : {}),
        },
      },
    );
    const exited = new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) resolve();
      else child.once("exit", () => resolve());
    });
    const stop = async () => {
      try {
        if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
          child.kill("SIGTERM");
          const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
          try {
            await exited;
          } finally {
            clearTimeout(timer);
          }
        }
      } finally {
        if (temporaryProfile) {
          await NodeFSP.rm(directory, { recursive: true, force: true }).catch(() => undefined);
        }
      }
    };
    try {
      const port = await new Promise<number>((resolve, reject) => {
        let output = "";
        const timer = setTimeout(() => finish(new Error("Firefox startup timed out")), 15_000);
        const finish = (cause?: unknown, readyPort?: number) => {
          clearTimeout(timer);
          child.off("error", failed);
          child.off("exit", onEarlyExit);
          child.stdout.off("data", read);
          child.stderr.off("data", read);
          if (cause) reject(cause);
          else resolve(readyPort!);
        };
        const failed = (cause: Error) => finish(cause);
        const onEarlyExit = () => finish(new Error("Firefox exited before Marionette was ready"));
        const read = (data: Buffer) => {
          output = (output + data.toString()).slice(-4_000);
          const match = /Marionette\s+INFO\s+Listening on port (\d+)/.exec(output);
          if (match) finish(undefined, Number(match[1]));
        };
        child.on("error", failed);
        child.on("exit", onEarlyExit);
        child.stdout.on("data", read);
        child.stderr.on("data", read);
      });
      if (child.pid === undefined) {
        throw new Error("Could not determine Firefox's process ID.");
      }
      child.stdout.resume();
      child.stderr.resume();
      return { port, pid: child.pid, profileDir: directory, stop, exited };
    } catch (cause) {
      await stop();
      throw cause;
    }
  } catch (cause) {
    if (isMarionetteError(cause)) throw cause;
    throw new MarionetteError({ code: "launch failed", command: "launch", cause });
  }
};

export const launch = Effect.fn("FirefoxProcess.launch")(function* (options: FirefoxLaunchOptions) {
  return yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: () => start(options),
      catch: (cause) =>
        isMarionetteError(cause)
          ? cause
          : new MarionetteError({ code: "launch failed", command: "launch", cause }),
    }),
    (running) => Effect.promise(running.stop),
  );
});
