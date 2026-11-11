import * as Schema from "effect/Schema";

import { ThreadId } from "./baseSchemas.ts";
import { ProviderDriverKind } from "./providerInstance.ts";

export const ComposerToolsListInput = Schema.Struct({
  threadId: Schema.NullOr(ThreadId),
  driver: Schema.NullOr(ProviderDriverKind),
  cwd: Schema.NullOr(Schema.String),
});
export type ComposerToolsListInput = typeof ComposerToolsListInput.Type;

export const ComposerToolStatus = Schema.Literals(["ready", "checking", "down", "needs-auth"]);
export type ComposerToolStatus = typeof ComposerToolStatus.Type;

export const ComposerToolEntry = Schema.Struct({
  name: Schema.String,
  description: Schema.NullOr(Schema.String),
  /** Set only where the source reports it: Claude names from `deferred_tools_delta`. */
  deferred: Schema.optional(Schema.Boolean),
});
export type ComposerToolEntry = typeof ComposerToolEntry.Type;

/** `T3` and the provider's own names are `t3` and `provider`; configured servers are `mcp`. */
export const ComposerToolGroup = Schema.Struct({
  source: Schema.String,
  kind: Schema.Literals(["t3", "provider", "mcp"]),
  status: ComposerToolStatus,
  tools: Schema.Array(ComposerToolEntry),
});
export type ComposerToolGroup = typeof ComposerToolGroup.Type;

/** Each emission is the whole list so far; the last one is complete. */
export const ComposerToolsSnapshot = Schema.Struct({
  groups: Schema.Array(ComposerToolGroup),
});
export type ComposerToolsSnapshot = typeof ComposerToolsSnapshot.Type;
