// @effect-diagnostics globalTimers:off nodeBuiltinImport:off -- The helper is a plain child process; its callbacks run outside Effect fibers.
import * as NodeChildProcess from "node:child_process";
import * as NodeReadline from "node:readline";
import * as Option from "effect/Option";

import {
  decodeWindowDockReply,
  type ScreenRect,
  type WindowDockReply,
  type WindowDockRequest,
} from "./WindowDockProtocol.ts";

const REQUEST_TIMEOUT_MS = 3_000;

type ResultReply = Extract<WindowDockReply, { readonly type: "result" }>;

export interface WindowDockSpawn {
  (
    executable: string,
  ): Pick<NodeChildProcess.ChildProcessWithoutNullStreams, "stdin" | "stdout"> &
    NodeChildProcess.ChildProcess;
}

export interface WindowDockClient {
  readonly alive: () => boolean;
  /** Without `prompt`, never shows a system dialog. */
  readonly checkTrusted: (prompt: boolean) => Promise<boolean>;
  readonly find: (
    pid: number,
  ) => Promise<
    | { readonly found: true; readonly frame: ScreenRect; readonly contentTop: number | undefined }
    | { readonly found: false; readonly untrusted: boolean }
  >;
  readonly watch: (pid: number) => void;
  readonly unwatch: (pid: number) => void;
  /** Latest wins: a frame still waiting for the helper is replaced, never queued behind. */
  readonly setFrame: (pid: number, frame: ScreenRect) => void;
  readonly raise: (pid: number) => void;
  readonly setMinimized: (pid: number, minimized: boolean) => void;
  readonly onClosed: (listener: (pid: number) => void) => () => void;
  readonly close: () => void;
}

const defaultSpawn: WindowDockSpawn = (executable) =>
  NodeChildProcess.spawn(executable, [], {
    stdio: ["pipe", "pipe", "inherit"],
  }) as ReturnType<WindowDockSpawn>;

export function startWindowDockClient(
  executable: string,
  spawn: WindowDockSpawn = defaultSpawn,
): WindowDockClient {
  let child: ReturnType<WindowDockSpawn> | undefined;
  try {
    child = spawn(executable);
  } catch {
    child = undefined;
  }
  let alive = child !== undefined;
  let nextId = 1;
  const pending = new Map<
    number,
    { readonly resolve: (reply: ResultReply | undefined) => void; readonly timer: NodeJS.Timeout }
  >();
  const closedListeners = new Set<(pid: number) => void>();
  const pendingFrames = new Map<number, ScreenRect>();
  let waitingForDrain = false;

  const write = (request: WindowDockRequest | (WindowDockRequest & { readonly id: number })) => {
    if (!alive || !child) return false;
    return child.stdin.write(`${JSON.stringify(request)}\n`, (error) => {
      if (error) shutdown();
    });
  };

  const shutdown = () => {
    if (!alive) return;
    alive = false;
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.resolve(undefined);
    }
    pending.clear();
    pendingFrames.clear();
    child?.kill();
  };

  const request = (message: WindowDockRequest) =>
    new Promise<ResultReply | undefined>((resolve) => {
      if (!alive) return resolve(undefined);
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        resolve(undefined);
      }, REQUEST_TIMEOUT_MS);
      timer.unref();
      pending.set(id, { resolve, timer });
      write({ ...message, id });
    });

  const drainFrames = () => {
    if (waitingForDrain) return;
    for (const [pid, frame] of pendingFrames) {
      pendingFrames.delete(pid);
      if (!write({ type: "setFrame", pid, ...frame })) {
        // Newer frames replace the one per pid still waiting while the pipe is full.
        waitingForDrain = true;
        child?.stdin.once("drain", () => {
          waitingForDrain = false;
          drainFrames();
        });
        return;
      }
    }
  };

  if (child) {
    NodeReadline.createInterface({ input: child.stdout }).on("line", (line) => {
      const reply = Option.getOrUndefined(decodeWindowDockReply(line));
      if (!reply) return;
      if (reply.type === "closed") {
        for (const listener of closedListeners) listener(reply.pid);
        return;
      }
      const entry = pending.get(reply.id);
      if (!entry) return;
      pending.delete(reply.id);
      clearTimeout(entry.timer);
      entry.resolve(reply);
    });
    child.once("exit", shutdown);
    child.once("error", shutdown);
    child.stdin.on("error", shutdown);
  }

  return {
    alive: () => alive,
    checkTrusted: async (prompt) => (await request({ type: "check", prompt }))?.trusted === true,
    find: async (pid) => {
      const reply = await request({ type: "find", pid });
      if (reply?.found && reply.frame) {
        return { found: true, frame: reply.frame, contentTop: reply.contentTop };
      }
      return { found: false, untrusted: reply?.reason === "untrusted" };
    },
    watch: (pid) => void write({ type: "watch", pid }),
    unwatch: (pid) => void write({ type: "unwatch", pid }),
    setFrame: (pid, frame) => {
      pendingFrames.set(pid, frame);
      drainFrames();
    },
    raise: (pid) => void write({ type: "raise", pid }),
    setMinimized: (pid, minimized) => void write({ type: "minimize", pid, minimized }),
    onClosed: (listener) => {
      closedListeners.add(listener);
      return () => closedListeners.delete(listener);
    },
    close: shutdown,
  };
}
