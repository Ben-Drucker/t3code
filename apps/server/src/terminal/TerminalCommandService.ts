// @effect-diagnostics nodeBuiltinImport:off -- Spawns detached process groups so Stop kills the entire command tree.
import * as NodeChildProcess from "node:child_process";

import {
  CommandId,
  MessageId,
  NodeId,
  OrchestratorMcpFailure,
  type RunId,
  type ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { signalProcessGroup } from "@t3tools/provider-core/server/processGroup";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as TurnStartNotes from "../orchestration-v2/TurnStartNotes.ts";
import * as ProjectService from "../project/ProjectService.ts";

const TERMINAL_COMMAND_FOREGROUND_TIMEOUT_MS = 60_000;
const TERMINAL_COMMAND_BUFFER_MAX_CHARS = 128 * 1024;
const TERMINAL_COMMAND_RESULT_MAX_CHARS = 32_000;
const TERMINAL_COMMAND_WAKE_MAX_CHARS = 8_000;
const TERMINAL_COMMAND_KILL_GRACE_MS = 2_000;
const TRUNCATION_MARKER = "[Earlier output truncated]\n";

export type TerminalRunMode = "foreground" | "background" | "background_with_timeout";

export interface TerminalCommandRunInput {
  readonly threadId: ThreadId;
  readonly command: string;
  readonly mode: TerminalRunMode;
  readonly timeoutSeconds?: number | undefined;
  readonly cwd?: string | undefined;
  readonly description?: string | undefined;
  readonly authorizedTurn?: { readonly runId: RunId; readonly cwd: string | null };
}

export interface TerminalCommandRunResult {
  readonly mode: TerminalRunMode;
  readonly status: "completed" | "failed" | "backgrounded" | "running";
  readonly taskId?: string;
  readonly exitCode?: number | null;
  readonly signal?: string | null;
  readonly output?: string;
  readonly truncated?: boolean;
  readonly durationMs?: number;
  readonly timeoutSeconds?: number;
  readonly message?: string;
}

export interface TerminalCommandServiceOptions {
  readonly foregroundTimeoutMs?: number;
}

export class TerminalCommandService extends Context.Service<
  TerminalCommandService,
  {
    readonly run: (
      input: TerminalCommandRunInput,
    ) => Effect.Effect<TerminalCommandRunResult, OrchestratorMcpFailure>;
    readonly interruptThread: (threadId: ThreadId) => Effect.Effect<void>;
    /** Ends the foreground wait of the thread's running commands; the commands keep running. */
    readonly backgroundThread: (threadId: ThreadId, reason: ReleaseReason) => Effect.Effect<void>;
  }
>()("t3/terminal/TerminalCommandService") {}

type ReleaseReason = "steer" | "stop";

interface ActiveJob {
  readonly taskId: string;
  readonly threadId: ThreadId;
  readonly turnItemId: TurnItemId;
  readonly command: string;
  readonly child: NodeChildProcess.ChildProcess;
  cancelledByStop: boolean;
  backgrounded: boolean;
  readonly release: Deferred.Deferred<ReleaseReason>;
  /** A parent-only Stop kept it running; its result waits for the user's next prompt. */
  heldByStop: boolean;
  exitNote?: string;
}

function stopHeldCommandNote(job: ActiveJob): string {
  const status =
    job.exitNote ??
    `Still running (task ${job.taskId}): \`${summarizeCommand(job.command)}\`. T3 Code will wake this thread when it exits.`;
  return `Note: when the user pressed Stop, T3 Code moved your running command to the background instead of killing it.\n\n${status}`;
}

class BoundedOutputBuffer {
  private text = "";
  private totalTruncated = false;

  append(chunk: string): void {
    if (chunk.length === 0) return;
    this.text += chunk;
    if (this.text.length > TERMINAL_COMMAND_BUFFER_MAX_CHARS) {
      this.text = this.text.slice(this.text.length - TERMINAL_COMMAND_BUFFER_MAX_CHARS);
      this.totalTruncated = true;
    }
  }

  snapshot(maxChars: number): { readonly output: string; readonly truncated: boolean } {
    if (this.text.length > maxChars) {
      const slice = this.text.slice(this.text.length - maxChars);
      return { output: `${TRUNCATION_MARKER}${slice}`, truncated: true };
    }
    if (this.totalTruncated) {
      return { output: `${TRUNCATION_MARKER}${this.text}`, truncated: true };
    }
    return { output: this.text, truncated: false };
  }
}

function shellCommandForPlatform(
  command: string,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): { readonly executable: string; readonly args: ReadonlyArray<string> } {
  if (platform === "win32") {
    return {
      executable: env.ComSpec || env.COMSPEC || "cmd.exe",
      args: ["/d", "/s", "/c", command],
    };
  }
  return {
    executable: env.SHELL || "/bin/sh",
    args: ["-c", command],
  };
}

function signalChildOrGroup(
  child: NodeChildProcess.ChildProcess,
  platform: NodeJS.Platform,
  signal: NodeJS.Signals,
): boolean {
  const pid = child.pid;
  if (pid === undefined) return false;
  if (platform === "win32") {
    try {
      NodeChildProcess.spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      return true;
    } catch {
      try {
        child.kill(signal);
        return true;
      } catch {
        return false;
      }
    }
  }
  try {
    signalProcessGroup(pid, signal);
    return true;
  } catch {
    try {
      child.kill(signal);
      return true;
    } catch {
      return false;
    }
  }
}

const terminateChildTree = Effect.fn("TerminalCommandService.terminateChildTree")(function* (
  child: NodeChildProcess.ChildProcess,
  platform: NodeJS.Platform,
  exited: Deferred.Deferred<{ readonly exitCode: number | null; readonly signal: string | null }>,
) {
  const signaled = yield* Effect.sync(() =>
    signalChildOrGroup(child, platform, platform === "win32" ? "SIGKILL" : "SIGTERM"),
  );
  if (!signaled || platform === "win32") return;
  const completed = yield* Deferred.await(exited).pipe(
    Effect.as(true),
    Effect.timeoutOrElse({
      duration: Duration.millis(TERMINAL_COMMAND_KILL_GRACE_MS),
      orElse: () => Effect.succeed(false),
    }),
  );
  if (!completed) {
    yield* Effect.sync(() => {
      signalChildOrGroup(child, platform, "SIGKILL");
    });
  }
});

function summarizeCommand(command: string): string {
  const singleLine = command.replaceAll(/\s+/g, " ").trim();
  return singleLine.length <= 72 ? singleLine : `${singleLine.slice(0, 71)}…`;
}

function formatWakeMessage(input: {
  readonly taskId: string;
  readonly command: string;
  readonly timedOut: boolean;
  readonly timeoutSeconds?: number | undefined;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly output: string;
}): string {
  const preview = summarizeCommand(input.command);
  const header = input.timedOut
    ? `Background command timed out after ${input.timeoutSeconds ?? 0}s (task ${input.taskId}): \`${preview}\``
    : input.exitCode === 0
      ? `Background command finished (exit code 0, task ${input.taskId}): \`${preview}\``
      : `Background command failed (exit code ${input.exitCode ?? "unknown"}${input.signal ? `, signal ${input.signal}` : ""}, task ${input.taskId}): \`${preview}\``;
  const trimmed = input.output.trimEnd();
  if (trimmed.length === 0) {
    return `${header}\n\n(no output)`;
  }
  return `${header}\n\nOutput:\n\`\`\`\n${trimmed}\n\`\`\``;
}

export const makeWithOptions = Effect.fn("TerminalCommandService.make")(function* (
  options: TerminalCommandServiceOptions = {},
) {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const turnStartNotes = yield* Effect.serviceOption(TurnStartNotes.TurnStartNotes);
  const projects = yield* ProjectService.ProjectService;
  const random = yield* SecureRandom.SecureRandom;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcess.Platform;
  const serviceScope = yield* Effect.scope;
  const foregroundTimeoutMs = options.foregroundTimeoutMs ?? TERMINAL_COMMAND_FOREGROUND_TIMEOUT_MS;

  const activeJobs = new Map<string, ActiveJob>();

  const killJob = Effect.fn("TerminalCommandService.killJob")(function* (job: ActiveJob) {
    if (job.cancelledByStop) return;
    job.cancelledByStop = true;
    const exited = yield* Deferred.make<{
      readonly exitCode: number | null;
      readonly signal: string | null;
    }>();
    if (job.child.exitCode !== null || job.child.signalCode !== null) {
      return;
    }
    job.child.once("exit", (code, signal) => {
      Deferred.doneUnsafe(exited, Exit.succeed({ exitCode: code, signal }));
    });
    yield* terminateChildTree(job.child, platform, exited);
  });

  const backgroundThread: TerminalCommandService["Service"]["backgroundThread"] = Effect.fn(
    "TerminalCommandService.backgroundThread",
  )(function* (threadId, reason) {
    for (const job of activeJobs.values()) {
      if (job.threadId === threadId && !job.backgrounded) {
        yield* Deferred.succeed(job.release, reason);
      }
    }
  });

  // A parent-only Stop keeps the thread's commands running and tells the agent on the next prompt.
  const holdThreadForStop = Effect.fn("TerminalCommandService.holdThreadForStop")(function* (
    threadId: ThreadId,
    notes: TurnStartNotes.TurnStartNotes["Service"],
  ) {
    for (const job of activeJobs.values()) {
      if (job.threadId !== threadId || job.cancelledByStop) continue;
      job.heldByStop = true;
      yield* notes.put(
        threadId,
        `terminal:${job.taskId}`,
        () => stopHeldCommandNote(job),
        () => {
          job.heldByStop = false;
        },
      );
      if (!job.backgrounded) yield* Deferred.succeed(job.release, "stop");
    }
  });

  // Kill active terminal jobs on Stop (run_interrupt_request fires immediately on interrupt commit;
  // command_execution interrupted fires from settleBackgroundWork even without a live session).
  yield* orchestrator.streamDomainEvents.pipe(
    Stream.runForEach((event) => {
      if (event.type !== "turn-item.updated") return Effect.void;
      const item = event.payload;
      // A steer is read only after the running tool call returns.
      if (
        item.type === "user_message" &&
        (item.inputIntent === "steer" || item.inputIntent === "promoted_queued_to_steer")
      ) {
        return backgroundThread(item.threadId, "steer");
      }
      if (item.type === "run_interrupt_request") {
        if (item.parentOnly === true && Option.isSome(turnStartNotes)) {
          return holdThreadForStop(item.threadId, turnStartNotes.value);
        }
        const matching = [...activeJobs.values()].filter((job) => job.threadId === item.threadId);
        return Effect.forEach(matching, killJob, { discard: true });
      }
      if (item.type === "command_execution" && item.status === "interrupted") {
        const matching = [...activeJobs.values()].filter(
          (job) => job.turnItemId === item.id && !job.heldByStop,
        );
        return Effect.forEach(matching, killJob, { discard: true });
      }
      return Effect.void;
    }),
    Effect.catchCause((cause) =>
      Effect.logWarning("TerminalCommandService stop listener failed", { cause }),
    ),
    Effect.forkIn(serviceScope),
  );

  yield* Scope.addFinalizer(
    serviceScope,
    Effect.forEach([...activeJobs.values()], killJob, { discard: true }).pipe(Effect.ignore),
  );

  const resolveRunTarget = Effect.fn("TerminalCommandService.resolveRunTarget")(function* (
    threadId: ThreadId,
    requestedCwd: string | undefined,
    authorizedTurn: TerminalCommandRunInput["authorizedTurn"],
  ) {
    const projection = yield* orchestrator.getThreadRecords(threadId, ["runs"]).pipe(
      Effect.mapError(
        (cause) =>
          new OrchestratorMcpFailure({
            code: "orchestration_error",
            message: `Could not read thread ${threadId}: ${cause.message}`,
          }),
      ),
    );
    const thread = projection.thread;
    const running = projection.runs.findLast(
      (run) => run.status === "preparing" || run.status === "starting" || run.status === "running",
    );
    if (
      authorizedTurn &&
      (thread.runtimeMode !== "full-access" ||
        thread.interactionMode !== "default" ||
        running?.id !== authorizedTurn.runId)
    ) {
      return yield* new OrchestratorMcpFailure({
        code: "invalid_request",
        message: "The T3 terminal requires an active Full access turn outside Plan mode.",
      });
    }
    const project = Option.getOrUndefined(
      yield* projects.getById(thread.projectId).pipe(
        Effect.mapError(
          () =>
            new OrchestratorMcpFailure({
              code: "orchestration_error",
              message: `Could not read project ${thread.projectId}.`,
            }),
        ),
      ),
    );
    const baseCwd = authorizedTurn?.cwd ?? thread.worktreePath ?? project?.workspaceRoot;
    if (baseCwd === undefined && (requestedCwd === undefined || !path.isAbsolute(requestedCwd))) {
      return yield* new OrchestratorMcpFailure({
        code: "invalid_request",
        message: "This thread has no workspace directory; pass an absolute `cwd`.",
      });
    }
    const targetCwd =
      requestedCwd === undefined
        ? baseCwd!
        : path.isAbsolute(requestedCwd)
          ? requestedCwd
          : path.resolve(baseCwd!, requestedCwd);
    const stat = yield* fs.stat(targetCwd).pipe(
      Effect.mapError(
        () =>
          new OrchestratorMcpFailure({
            code: "invalid_request",
            message: `Working directory does not exist: ${targetCwd}`,
          }),
      ),
    );
    if (stat.type !== "Directory") {
      return yield* new OrchestratorMcpFailure({
        code: "invalid_request",
        message: `Working directory is not a directory: ${targetCwd}`,
      });
    }
    const activeRun = running ?? projection.runs.findLast((run) => run.status !== "queued");
    if (activeRun === undefined || activeRun.rootNodeId === null) {
      return yield* new OrchestratorMcpFailure({
        code: "orchestration_error",
        message: `Thread ${threadId} has no active run for background terminal tracking.`,
      });
    }
    return {
      cwd: targetCwd,
      runId: activeRun.id as RunId,
      nodeId: activeRun.rootNodeId as NodeId,
    };
  });

  const recordCommand = Effect.fn("TerminalCommandService.recordCommand")(function* (input: {
    readonly threadId: ThreadId;
    readonly runId: RunId;
    readonly nodeId: NodeId;
    readonly turnItemId: TurnItemId;
    readonly taskId: string;
    readonly command: string;
    readonly title: string | undefined;
    readonly commandSummary?: string | undefined;
    readonly commandStatus: "running" | "completed" | "failed" | "interrupted";
    readonly exitCode?: number | null | undefined;
    readonly output?: string | undefined;
    readonly awaited: boolean;
    readonly wake?:
      | {
          readonly messageId: MessageId;
          readonly text: string;
          readonly notification: {
            readonly source: { readonly kind: "command" };
            readonly outcome: "completed" | "failed";
            readonly summary: string;
          };
        }
      | undefined;
  }) {
    const uuid = yield* random.uuidV4();
    yield* orchestrator
      .dispatch({
        type: "terminal_command.record",
        commandId: CommandId.make(`server:terminal-command:${input.taskId}:${uuid}`),
        threadId: input.threadId,
        runId: input.runId,
        nodeId: input.nodeId,
        turnItemId: input.turnItemId,
        taskId: input.taskId,
        command: input.command,
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(input.commandSummary === undefined ? {} : { commandSummary: input.commandSummary }),
        commandStatus: input.commandStatus,
        ...(input.exitCode === undefined ? {} : { exitCode: input.exitCode }),
        ...(input.output === undefined ? {} : { output: input.output }),
        awaited: input.awaited,
        ...(input.wake === undefined ? {} : { wake: input.wake }),
      })
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("TerminalCommandService.recordCommand failed", {
            taskId: input.taskId,
            threadId: input.threadId,
            cause,
          }),
        ),
      );
  });

  const run: TerminalCommandService["Service"]["run"] = Effect.fn("TerminalCommandService.run")(
    function* (input) {
      if (input.mode === "background_with_timeout" && (input.timeoutSeconds ?? 0) < 1) {
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: "`timeoutSeconds` (>= 1) is required when `mode` is `background_with_timeout`.",
        });
      }
      if (input.mode !== "background_with_timeout" && input.timeoutSeconds !== undefined) {
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: "`timeoutSeconds` is only valid when `mode` is `background_with_timeout`.",
        });
      }

      const { cwd, runId, nodeId } = yield* resolveRunTarget(
        input.threadId,
        input.cwd,
        input.authorizedTurn,
      );
      const idSuffix = yield* random.uuidV4();
      const taskId = `terminal:${idSuffix}`;
      const turnItemId = TurnItemId.make(`item:terminal:${idSuffix}`);
      const commandSummary = input.description?.trim().slice(0, 512).trimEnd() || undefined;
      const title = commandSummary ?? summarizeCommand(input.command);
      const commandItem = {
        threadId: input.threadId,
        runId,
        nodeId,
        turnItemId,
        taskId,
        command: input.command,
        title,
        commandSummary,
      };

      const shell = shellCommandForPlatform(input.command, platform, process.env);
      const startedAtMs = yield* Clock.currentTimeMillis;
      const outputBuffer = new BoundedOutputBuffer();
      const exitDeferred = yield* Deferred.make<{
        readonly exitCode: number | null;
        readonly signal: string | null;
        readonly error?: Error | undefined;
      }>();

      const child = yield* Effect.try({
        try: () =>
          NodeChildProcess.spawn(shell.executable, [...shell.args], {
            cwd,
            env: { ...process.env, T3CODE_THREAD_ID: input.threadId },
            stdio: ["ignore", "pipe", "pipe"],
            detached: platform !== "win32",
            windowsHide: true,
          }),
        catch: (cause) =>
          new OrchestratorMcpFailure({
            code: "orchestration_error",
            message: `Could not start command: ${cause instanceof Error ? cause.message : String(cause)}`,
          }),
      }).pipe(
        Effect.tapError((error) =>
          recordCommand({
            ...commandItem,
            commandStatus: "failed",
            output: error.message,
            awaited: false,
          }),
        ),
      );

      const job: ActiveJob = {
        taskId,
        threadId: input.threadId,
        turnItemId,
        command: input.command,
        child,
        cancelledByStop: false,
        backgrounded: input.mode !== "foreground",
        release: yield* Deferred.make<ReleaseReason>(),
        heldByStop: false,
      };
      activeJobs.set(taskId, job);

      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => outputBuffer.append(chunk));
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (chunk: string) => outputBuffer.append(chunk));
      child.once("error", (error) => {
        outputBuffer.append(`\n${error.message}\n`);
        Deferred.doneUnsafe(exitDeferred, Exit.succeed({ exitCode: null, signal: null, error }));
      });
      child.once("close", (exitCode, signal) => {
        Deferred.doneUnsafe(exitDeferred, Exit.succeed({ exitCode, signal }));
      });

      const launchBackgroundMonitor = Effect.fn("TerminalCommandService.backgroundMonitor")(
        function* (timeoutSeconds: number | undefined) {
          let timedOut = false;
          let exitResult: {
            readonly exitCode: number | null;
            readonly signal: string | null;
            readonly error?: Error | undefined;
          };
          if (timeoutSeconds === undefined) {
            exitResult = yield* Deferred.await(exitDeferred);
          } else {
            const raced = yield* Deferred.await(exitDeferred).pipe(
              Effect.map((result) => ({ kind: "exited" as const, result })),
              Effect.timeoutOrElse({
                duration: Duration.seconds(timeoutSeconds),
                orElse: () => Effect.succeed({ kind: "timed_out" as const }),
              }),
            );
            if (raced.kind === "timed_out") {
              timedOut = true;
              if (!job.cancelledByStop) {
                yield* terminateChildTree(
                  child,
                  platform,
                  exitDeferred as Deferred.Deferred<{
                    readonly exitCode: number | null;
                    readonly signal: string | null;
                  }>,
                );
              }
              exitResult = yield* Deferred.await(exitDeferred).pipe(
                Effect.timeoutOrElse({
                  duration: Duration.seconds(2),
                  orElse: () => Effect.succeed({ exitCode: null, signal: "SIGKILL" }),
                }),
              );
            } else {
              exitResult = raced.result;
            }
          }
          activeJobs.delete(taskId);

          if (job.cancelledByStop) {
            yield* recordCommand({
              ...commandItem,
              commandStatus: "interrupted",
              exitCode: exitResult.exitCode,
              output: outputBuffer.snapshot(TERMINAL_COMMAND_RESULT_MAX_CHARS).output,
              awaited: false,
            });
            return;
          }

          const succeeded = !timedOut && exitResult.exitCode === 0;
          const resultOutput = outputBuffer.snapshot(TERMINAL_COMMAND_RESULT_MAX_CHARS).output;
          const wakeOutput = outputBuffer.snapshot(TERMINAL_COMMAND_WAKE_MAX_CHARS).output;
          const wakeText = formatWakeMessage({
            taskId,
            command: input.command,
            timedOut,
            timeoutSeconds,
            exitCode: exitResult.exitCode,
            signal: exitResult.signal,
            output: wakeOutput,
          });
          if (job.heldByStop) {
            job.exitNote = wakeText;
            yield* recordCommand({
              ...commandItem,
              commandStatus: succeeded ? "completed" : "failed",
              exitCode: timedOut ? null : exitResult.exitCode,
              output: resultOutput,
              awaited: false,
            });
            return;
          }
          const wakeMessageId = MessageId.make(
            `message:terminal:${idSuffix}:${yield* random.uuidV4()}`,
          );
          yield* recordCommand({
            ...commandItem,
            commandStatus: succeeded ? "completed" : "failed",
            exitCode: timedOut ? null : exitResult.exitCode,
            output: timedOut
              ? `${resultOutput}${resultOutput.endsWith("\n") || resultOutput.length === 0 ? "" : "\n"}[Timed out after ${timeoutSeconds}s]`
              : resultOutput,
            awaited: false,
            wake: {
              messageId: wakeMessageId,
              text: wakeText,
              notification: {
                source: { kind: "command" },
                outcome: succeeded ? "completed" : "failed",
                summary: timedOut
                  ? `${title}: timed out after ${timeoutSeconds}s`
                  : succeeded
                    ? `${title}: completed`
                    : `${title}: exited with code ${exitResult.exitCode ?? "unknown"}`,
              },
            },
          });
        },
        (effect) =>
          effect.pipe(
            Effect.catchCause((cause) => {
              activeJobs.delete(taskId);
              return Effect.logWarning("TerminalCommandService background watcher failed", {
                taskId,
                cause,
              });
            }),
            Effect.forkIn(serviceScope),
          ),
      );

      yield* recordCommand({
        ...commandItem,
        commandStatus: "running",
        awaited: input.mode !== "foreground",
      });
      if (input.mode === "background" || input.mode === "background_with_timeout") {
        yield* launchBackgroundMonitor(
          input.mode === "background_with_timeout" ? input.timeoutSeconds : undefined,
        );
        return {
          mode: input.mode,
          status: "running",
          taskId,
          ...(input.timeoutSeconds === undefined ? {} : { timeoutSeconds: input.timeoutSeconds }),
          message:
            input.mode === "background_with_timeout"
              ? `Command started in background with a ${input.timeoutSeconds}s timeout. T3 Code will wake this thread when it finishes or times out.`
              : "Command started in background. T3 Code will wake this thread when it finishes.",
        };
      }

      // Foreground mode: race completion against hard 60s escalation timeout.
      const foregroundOutcome = yield* Effect.raceFirst(
        Deferred.await(exitDeferred).pipe(
          Effect.map((result) => ({ kind: "exited" as const, result })),
          Effect.timeoutOrElse({
            duration: Duration.millis(foregroundTimeoutMs),
            orElse: () => Effect.succeed({ kind: "escalate" as const }),
          }),
        ),
        Deferred.await(job.release).pipe(
          Effect.map((reason) => ({ kind: "released" as const, reason })),
        ),
      ).pipe(
        // A Stop can cancel this tool call before the release lands; the held command still needs a watcher.
        Effect.onInterrupt(() =>
          job.heldByStop && !job.backgrounded
            ? Effect.suspend(() => {
                job.backgrounded = true;
                return launchBackgroundMonitor(undefined);
              })
            : Effect.void,
        ),
      );

      if (foregroundOutcome.kind === "exited") {
        activeJobs.delete(taskId);
        const endedAtMs = yield* Clock.currentTimeMillis;
        const { output, truncated } = outputBuffer.snapshot(TERMINAL_COMMAND_RESULT_MAX_CHARS);
        const succeeded = !job.cancelledByStop && foregroundOutcome.result.exitCode === 0;
        yield* recordCommand({
          ...commandItem,
          commandStatus: job.cancelledByStop ? "interrupted" : succeeded ? "completed" : "failed",
          exitCode: foregroundOutcome.result.exitCode,
          output,
          awaited: false,
        });
        return {
          mode: "foreground",
          status: succeeded ? "completed" : "failed",
          exitCode: foregroundOutcome.result.exitCode,
          signal: foregroundOutcome.result.signal,
          output,
          truncated,
          durationMs: Math.max(0, endedAtMs - startedAtMs),
          ...(job.cancelledByStop ? { message: "Command stopped by user." } : {}),
        };
      }

      if (job.cancelledByStop) {
        activeJobs.delete(taskId);
        const { output, truncated } = outputBuffer.snapshot(TERMINAL_COMMAND_RESULT_MAX_CHARS);
        return {
          mode: "foreground",
          status: "failed",
          exitCode: null,
          signal: "SIGTERM",
          output,
          truncated,
          message: "Command stopped by user.",
        };
      }

      job.backgrounded = true;
      const { output, truncated } = outputBuffer.snapshot(TERMINAL_COMMAND_RESULT_MAX_CHARS);
      yield* recordCommand({
        ...commandItem,
        commandStatus: "running",
        output,
        awaited: true,
      });
      yield* launchBackgroundMonitor(undefined);
      return {
        mode: "foreground",
        status: "backgrounded",
        taskId,
        output,
        truncated,
        message:
          foregroundOutcome.kind === "released"
            ? foregroundOutcome.reason === "stop"
              ? "Command moved to background mode because the user pressed Stop. It is still running."
              : "Command moved to background mode because the user sent a message while it ran. It is still running; T3 Code will wake this thread when it exits."
            : "Command did not finish within the 60s foreground timeout and moved to background mode. T3 Code will show the thread waiting and wake it when the command exits.",
      };
    },
  );

  const interruptThread: TerminalCommandService["Service"]["interruptThread"] = Effect.fn(
    "TerminalCommandService.interruptThread",
  )(function* (threadId) {
    const matching = [...activeJobs.values()].filter((job) => job.threadId === threadId);
    yield* Effect.forEach(matching, killJob, { discard: true });
  });

  return TerminalCommandService.of({ run, interruptThread, backgroundThread });
});

export const layer = Layer.effect(TerminalCommandService, makeWithOptions());
