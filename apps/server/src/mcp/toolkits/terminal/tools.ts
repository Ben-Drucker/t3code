import {
  McpCapabilityUnavailableError,
  OrchestratorMcpFailure,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { McpSchema, Tool, Toolkit } from "effect/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as TerminalCommandService from "../../../terminal/TerminalCommandService.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
  TerminalCommandService.TerminalCommandService,
];

const TerminalRunModeSchema = Schema.Literals([
  "foreground",
  "background",
  "background_with_timeout",
]);

const TerminalRunInput = Schema.Struct({
  command: TrimmedNonEmptyString.annotate({
    description: "Shell command to run in the workspace.",
  }),
  mode: Schema.optional(TerminalRunModeSchema).annotate({
    description:
      "Execution mode. 'foreground' (default) waits up to 60s and moves to background if still running; 'background' runs asynchronously and wakes this thread on exit; 'background_with_timeout' runs asynchronously and fails after timeoutSeconds.",
  }),
  timeoutSeconds: Schema.optional(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(86_400)),
  ).annotate({
    description:
      "Hard timeout in seconds. Required when mode is 'background_with_timeout'; omit otherwise.",
  }),
  cwd: Schema.optional(TrimmedNonEmptyString).annotate({
    description:
      "Optional working directory (absolute or relative to the thread workspace). Defaults to the thread workspace.",
  }),
  description: Schema.optional(TrimmedNonEmptyString).annotate({
    description: "Short label shown in T3 Code's timeline and background wait indicator.",
  }),
});

const TerminalRunResult = Schema.Struct({
  mode: TerminalRunModeSchema,
  status: Schema.Literals(["completed", "failed", "backgrounded", "running"]),
  taskId: Schema.optional(Schema.String),
  exitCode: Schema.optional(Schema.NullOr(Schema.Int)),
  signal: Schema.optional(Schema.NullOr(Schema.String)),
  output: Schema.optional(Schema.String),
  truncated: Schema.optional(Schema.Boolean),
  durationMs: Schema.optional(Schema.Number),
  timeoutSeconds: Schema.optional(Schema.Int),
  message: Schema.optional(Schema.String),
});

const TerminalRunTool = Tool.make("t3_terminal_run", {
  description:
    "Run a shell command through T3 Code (Antigravity replacement for run_command). Modes: 'foreground' (default; 60s limit then moves to background), 'background' (returns taskId, marks thread waiting, wakes thread on completion), or 'background_with_timeout' (same as background with timeoutSeconds).",
  parameters: TerminalRunInput,
  success: TerminalRunResult,
  failure: Schema.Union([McpCapabilityUnavailableError, OrchestratorMcpFailure]),
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Run terminal command")
  .annotate(Tool.Destructive, true)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenWithoutTerminalCapability);

export const TerminalToolkit = Toolkit.make(TerminalRunTool);
