import {
  OrchestratorMcpFailure,
  ServerProvider,
  ServerProviderUsageLimits,
  UsageLimitSourceAccount,
  IsoDateTime,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import * as ProviderRegistry from "../../../provider/ProviderRegistry.ts";
import * as UsageLimitSources from "../../../usage/UsageLimitSources.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ProviderRegistry.ProviderRegistry,
    UsageLimitSources.UsageLimitSources,
  ],
};

const UsageWindow = Schema.Struct({
  id: TrimmedNonEmptyString,
  kind: Schema.Literals(["session", "weekly", "monthly", "other"]),
  label: TrimmedNonEmptyString,
  usedPercent: Schema.Number,
  remainingPercent: Schema.Number,
  resetsAt: Schema.optional(IsoDateTime),
  windowDurationMins: Schema.optional(Schema.Number),
});

const Limits = Schema.Struct({
  ...ServerProviderUsageLimits.fields,
  windows: Schema.Array(UsageWindow),
});

const ProviderSummary = Schema.Struct({
  instanceId: ServerProvider.fields.instanceId,
  driver: ServerProvider.fields.driver,
  displayName: Schema.optional(Schema.String),
  enabled: Schema.Boolean,
  installed: Schema.Boolean,
  status: ServerProvider.fields.status,
  hasUsageLimits: Schema.Boolean,
});

const UsageProvidersTool = Tool.make("t3_usage_providers", {
  ...shared,
  description:
    "List the providers (and accounts) this server knows, with ids to pass to `t3_usage_read`.",
  parameters: Tool.EmptyParams,
  success: Schema.Struct({ providers: Schema.Array(ProviderSummary) }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const UsageReadTool = Tool.make("t3_usage_read", {
  ...shared,
  description:
    "Read everything T3 knows about one provider's usage: every quota window (used and remaining percent, reset time), reset credits, external usage link, and account, plan, auth and status details. `provider` is a provider instance id, a driver such as `codex` or `claudeAgent`, or a display name; a driver with several accounts returns each. Use `t3_usage_providers` for the choices.",
  parameters: Schema.Struct({ provider: TrimmedNonEmptyString }),
  success: Schema.Struct({
    provider: Schema.String,
    matches: Schema.Array(
      Schema.Struct({
        ...ProviderSummary.fields,
        version: ServerProvider.fields.version,
        auth: ServerProvider.fields.auth,
        message: ServerProvider.fields.message,
        availability: ServerProvider.fields.availability,
        unavailableReason: ServerProvider.fields.unavailableReason,
        checkedAt: ServerProvider.fields.checkedAt,
        modelCount: Schema.Number,
        usageLimits: Schema.optional(Limits),
      }),
    ),
    externalSources: Schema.Array(
      Schema.Struct({
        sourceId: Schema.String,
        label: Schema.String,
        checkedAt: IsoDateTime,
        error: Schema.optional(Schema.String),
        accounts: Schema.Array(
          Schema.Struct({
            ...UsageLimitSourceAccount.fields,
            usageLimits: Limits,
          }),
        ),
      }),
    ),
  }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

export const UsageToolkit = Toolkit.make(UsageProvidersTool, UsageReadTool);
