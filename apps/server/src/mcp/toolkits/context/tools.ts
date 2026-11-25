import { OrchestratorMcpFailure, ThreadId } from "@t3tools/contracts";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const Tokens = Schema.NullOr(Schema.Number);

const ContextReadTool = Tool.make("t3_context_read", {
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    SecureRandom.SecureRandom,
  ],
  description:
    "Read a thread's context window: tokens used, the window size, the token count where it auto-compacts, how many tokens remain before that, and how many times it has compacted. Omit `threadId` to read your own thread. Null means the provider has not reported that number.",
  parameters: Schema.Struct({ threadId: Schema.optional(ThreadId) }),
  success: Schema.Struct({
    threadId: ThreadId,
    usedTokens: Tokens,
    maxTokens: Tokens,
    usedPercent: Tokens,
    autoCompactThreshold: Tokens,
    tokensUntilCompaction: Tokens,
    compactionCount: Schema.Number,
    contextLimitSetting: Tokens,
    compactBufferPercentSetting: Tokens,
    updatedAt: Schema.NullOr(Schema.String),
  }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

export const ContextToolkit = Toolkit.make(ContextReadTool);
