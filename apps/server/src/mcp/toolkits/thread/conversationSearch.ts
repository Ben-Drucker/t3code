import { type EnvironmentId, OrchestratorMcpFailure, ThreadId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type * as Tool from "effect/ai/Tool";

import { ThreadSearch } from "../../../orchestration-v2/ThreadSearch.ts";
import type { TranscriptRegexHit } from "../../../orchestration-v2/TranscriptRegexSearch.ts";
import { PeerForwarding } from "../../../peer/PeerForwarding.ts";
import { threadLinkFor } from "../../McpInvocationContext.ts";
import { fencingLinkOrigin } from "../../linkOrigin.ts";
import { readCaller } from "../../threadAccess.ts";
import { SearchConversationsPeerTool, type SearchConversationsTool } from "./tools.ts";

function conversationDate(value: string | undefined, boundary: "start" | "end") {
  if (value === undefined) return undefined;
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/u.test(value);
  const timestamp = DateTime.make(
    dateOnly ? `${value}T${boundary === "start" ? "00:00:00.000" : "23:59:59.999"}Z` : value,
  );
  if (timestamp._tag === "None") return null;
  const iso = DateTime.formatIso(timestamp.value);
  return dateOnly && !iso.startsWith(value) ? null : iso;
}

type Input = Tool.Parameters<typeof SearchConversationsTool>;
type Result = Tool.Success<typeof SearchConversationsTool>;
type Match = Result["matches"][number];
type SearchPage = Omit<Tool.Success<typeof SearchConversationsPeerTool>, "matches"> & {
  readonly matches: ReadonlyArray<TranscriptRegexHit>;
};

const compare = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);

export const searchConversations = Effect.fn("mcp.searchConversations")(function* ({
  environmentId,
  environmentIds,
  ...input
}: Input) {
  const deadline = (yield* Clock.currentTimeMillis) + (input.timeoutMs ?? 3000);
  const remaining = Clock.currentTimeMillis.pipe(Effect.map((now) => Math.max(0, deadline - now)));
  const caller = yield* readCaller();
  const { scope } = caller;
  const local = scope.environmentId;
  const start = conversationDate(input.start, "start");
  const end = conversationDate(input.end, "end");
  if (start === null || end === null || (start !== undefined && end !== undefined && start > end))
    return yield* new OrchestratorMcpFailure({
      code: "invalid_request",
      message: "Use valid ISO dates or timestamps with start before or equal to end.",
    });
  if (environmentId !== undefined && environmentIds !== undefined)
    return yield* new OrchestratorMcpFailure({
      code: "invalid_request",
      message: "Choose either environmentId or environmentIds.",
    });
  yield* Effect.try({
    try: () => new RegExp(input.pattern, "u"),
    catch: () =>
      new OrchestratorMcpFailure({
        code: "invalid_request",
        message: "Invalid regular expression.",
      }),
  });

  const requested = environmentIds ?? (environmentId === undefined ? undefined : [environmentId]);
  const requestedPeers =
    requested === undefined ? undefined : new Set(requested.filter((id) => id !== local));
  const pending = new Set<EnvironmentId>();
  const issues: Result["incompleteEnvironments"][number][] = [];
  const limit = input.limit ?? 20;
  const direction = input.order === "oldest" ? 1 : -1;
  let matches: Match[] = [];
  let truncated = false;
  const accept = (id: EnvironmentId, result: SearchPage) => {
    if (result.timedOut) issues.push({ environmentId: id, reason: "timed_out" });
    const combined = matches.concat(
      result.matches.map((hit) => {
        const threadId = ThreadId.make(hit.threadId);
        return {
          ...hit,
          threadId,
          environmentId: id,
          link: threadLinkFor({ ...scope, environmentId: id }, threadId),
        };
      }),
    );
    // Within a source, keep SQLite's existing item order for equal timestamps.
    combined.sort(
      (a, b) =>
        direction * compare(a.updatedAt, b.updatedAt) || compare(a.environmentId, b.environmentId),
    );
    truncated ||= result.truncated || combined.length > limit;
    matches = combined.slice(0, limit);
  };

  const searchLocal = Effect.gen(function* () {
    if (requested !== undefined && !requested.includes(local)) return;
    const timeoutMs = yield* remaining;
    if (timeoutMs === 0) {
      issues.push({ environmentId: local, reason: "timed_out" });
      return;
    }
    const search = yield* ThreadSearch;
    const result = yield* search
      .searchConversations({ ...input, start, end, timeoutMs })
      .pipe(Effect.result);
    if (result._tag === "Success") accept(local, result.success);
    else issues.push({ environmentId: local, reason: "unavailable" });
  });

  const searchPeers = Effect.gen(function* () {
    if (requestedPeers?.size === 0) return;
    if (
      scope.client?.linked === true ||
      scope.linkedEnvironments === false ||
      fencingLinkOrigin(caller) !== undefined
    ) {
      for (const id of requestedPeers ?? [])
        issues.push({ environmentId: id, reason: "unavailable" });
      return;
    }
    const forwarding = yield* PeerForwarding;
    const budget = yield* remaining;
    let discovering = true;
    const completed = yield* Effect.gen(function* () {
      const discovered = yield* forwarding.searchTargets(scope).pipe(Effect.result);
      discovering = false;
      if (discovered._tag === "Failure") {
        if (requestedPeers === undefined)
          issues.push({ environmentId: local, reason: "discovery_failed" });
        else
          for (const id of requestedPeers)
            issues.push({ environmentId: id, reason: "unavailable" });
        return;
      }
      const targets = new Set(discovered.success.filter((id) => id !== local));
      for (const id of requestedPeers ?? targets) {
        if (targets.has(id)) pending.add(id);
        else issues.push({ environmentId: id, reason: "unavailable" });
      }
      yield* Effect.forEach(
        [...pending],
        Effect.fnUntraced(function* (id) {
          const timeoutMs = yield* remaining;
          if (timeoutMs === 0) return;
          const response = yield* forwarding
            .call(scope, SearchConversationsPeerTool, id, { ...input, start, end, timeoutMs })
            .pipe(Effect.result);
          pending.delete(id);
          if (response._tag === "Success") accept(id, response.success);
          else {
            const unsupported =
              response.failure.code === "invalid_request" &&
              response.failure.message === "Tool 't3_search_convos' not found";
            issues.push({ environmentId: id, reason: unsupported ? "unsupported" : "unavailable" });
          }
        }),
        { concurrency: 3, discard: true },
      );
    }).pipe(Effect.timeoutOption(budget));
    const timedOut =
      completed._tag === "None" && discovering ? (requestedPeers ?? [local]) : pending;
    for (const id of timedOut) issues.push({ environmentId: id, reason: "timed_out" });
  });

  yield* Effect.all([searchLocal, searchPeers], { concurrency: 2, discard: true });
  const timedOut = issues.some((issue) => issue.reason === "timed_out");
  return {
    matches,
    timedOut,
    truncated: truncated || timedOut,
    partial: issues.length > 0,
    incompleteEnvironments: issues.sort((a, b) => compare(a.environmentId, b.environmentId)),
  } satisfies Result;
});
