// @effect-diagnostics globalTimers:off nodeBuiltinImport:off -- The helper is a plain child process; its callbacks run outside Effect fibers.
import * as NodeChildProcess from "node:child_process";
import * as NodeReadline from "node:readline";
import * as Option from "effect/Option";

import {
  decodeWindowDockReply,
  type ScreenRect,
  type WindowDockCandidateWindow,
  type WindowDockReply,
  type WindowDockRequest,
} from "./WindowDockProtocol.ts";

const REQUEST_TIMEOUT_MS = 3_000;

type ResultReply = Extract<WindowDockReply, { readonly type: "result" }>;

export interface WindowDockFrameChangedEvent {
  readonly pid: number;
  readonly windowId: number;
  readonly frame: ScreenRect;
}

export interface WindowDockClosedEvent {
  readonly pid: number;
  readonly windowId: number | undefined;
}

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
  readonly find: (pid: number) => Promise<
    | {
        readonly found: true;
        readonly windows: ReadonlyArray<WindowDockCandidateWindow>;
        readonly contentTop: number | undefined;
      }
    | { readonly found: false; readonly untrusted: boolean; readonly windows: readonly [] }
  >;
  readonly watch: (pid: number, windowId: number) => void;
  readonly unwatch: (pid: number, windowId?: number) => void;
  /** Latest wins: a frame still waiting for the helper is replaced, never queued behind. */
  readonly setFrame: (pid: number, windowId: number, frame: ScreenRect) => void;
  readonly raise: (pid: number, windowId: number) => void;
  readonly setMinimized: (pid: number, windowId: number, minimized: boolean) => void;
  readonly onClosed: (listener: (event: WindowDockClosedEvent) => void) => () => void;
  readonly onFrameChanged: (listener: (event: WindowDockFrameChangedEvent) => void) => () => void;
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
  const closedListeners = new Set<(event: WindowDockClosedEvent) => void>();
  const frameChangedListeners = new Set<(event: WindowDockFrameChangedEvent) => void>();
  const pendingFrames = new Map<
    string,
    { readonly pid: number; readonly windowId: number; readonly frame: ScreenRect }
  >();
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
    for (const [targetKey, { pid, windowId, frame }] of pendingFrames) {
      pendingFrames.delete(targetKey);
      if (!write({ type: "setFrame", pid, windowId, ...frame })) {
        // Newer frames replace the one per window still waiting while the pipe is full.
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
        const event = { pid: reply.pid, windowId: reply.windowId };
        for (const listener of closedListeners) listener(event);
        return;
      }
      if (reply.type === "frameChanged") {
        const event = { pid: reply.pid, windowId: reply.windowId, frame: reply.frame };
        for (const listener of frameChangedListeners) listener(event);
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
      const windows =
        reply?.windows && reply.windows.length > 0
          ? reply.windows
          : reply?.found && reply.frame
            ? [
                {
                  windowId: reply.windowId ?? 1,
                  pid,
                  standard: true,
                  minimized: false,
                  frame: reply.frame,
                },
              ]
            : [];
      if (windows.length > 0) {
        return { found: true, windows, contentTop: reply?.contentTop };
      }
      return { found: false, untrusted: reply?.reason === "untrusted", windows: [] };
    },
    watch: (pid, windowId) => void write({ type: "watch", pid, windowId }),
    unwatch: (pid, windowId) =>
      void write({
        type: "unwatch",
        pid,
        ...(windowId === undefined ? {} : { windowId }),
      }),
    setFrame: (pid, windowId, frame) => {
      pendingFrames.set(`${pid}:${windowId}`, { pid, windowId, frame });
      drainFrames();
    },
    raise: (pid, windowId) => void write({ type: "raise", pid, windowId }),
    setMinimized: (pid, windowId, minimized) =>
      void write({ type: "minimize", pid, windowId, minimized }),
    onClosed: (listener) => {
      closedListeners.add(listener);
      return () => closedListeners.delete(listener);
    },
    onFrameChanged: (listener) => {
      frameChangedListeners.add(listener);
      return () => frameChangedListeners.delete(listener);
    },
    close: shutdown,
  };
}
