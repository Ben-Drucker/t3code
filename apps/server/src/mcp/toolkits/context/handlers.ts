import type { OrchestrationV2ThreadProjection } from "@t3tools/contracts";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { readThread } from "../../threadAccess.ts";
import { ContextToolkit } from "./tools.ts";

type ContextProjection = Pick<
  OrchestrationV2ThreadProjection,
  "thread" | "providerThreads" | "providerTurns" | "turnItems"
>;

function positiveOption(projection: ContextProjection, id: string): number | null {
  const value = Number(getModelSelectionStringOptionValue(projection.thread.modelSelection, id));
  return Number.isFinite(value) && value > 0 ? value : null;
}

/** The newest usage report for the active provider thread, or a later compaction's result. */
export function summarizeContext(projection: ContextProjection) {
  const activeId = projection.thread.activeProviderThreadId;
  const providerThread = projection.providerThreads.find((thread) => thread.id === activeId);
  let usage: {
    usedTokens: number;
    maxTokens: number | null;
    threshold: number | null;
    at: string;
  } | null = null;
  for (const turn of projection.providerTurns) {
    const tokenUsage = turn.tokenUsage;
    if (tokenUsage === undefined || (activeId && turn.providerThreadId !== activeId)) continue;
    if (usage === null || Date.parse(tokenUsage.updatedAt) >= Date.parse(usage.at)) {
      usage = {
        usedTokens: tokenUsage.usedTokens,
        maxTokens: tokenUsage.maxTokens ?? null,
        threshold: tokenUsage.autoCompactThreshold ?? null,
        at: tokenUsage.updatedAt,
      };
    }
  }
  const reported = providerThread?.contextUsage;
  if (usage === null && reported != null && providerThread !== undefined) {
    usage = {
      usedTokens: reported.usedTokens,
      maxTokens: reported.maxTokens ?? null,
      threshold: reported.autoCompactThreshold ?? null,
      at: DateTime.formatIso(providerThread.updatedAt),
    };
  }
  const compactions = projection.turnItems.filter(
    (item) => item.type === "compaction" && item.status === "completed",
  );
  const latest = compactions
    .filter(
      (item) => !activeId || item.providerThreadId == null || item.providerThreadId === activeId,
    )
    .at(-1);
  if (latest?.type === "compaction" && latest.afterTokenCount !== undefined) {
    const compactedAt = DateTime.formatIso(latest.completedAt ?? latest.updatedAt);
    if (usage === null || Date.parse(compactedAt) > Date.parse(usage.at)) {
      usage = {
        usedTokens: latest.afterTokenCount,
        maxTokens: usage?.maxTokens ?? null,
        threshold: usage?.threshold ?? null,
        at: compactedAt,
      };
    }
  }
  const used = usage?.usedTokens ?? null;
  const max = usage?.maxTokens ?? null;
  const threshold = usage?.threshold ?? null;
  return {
    threadId: projection.thread.id,
    usedTokens: used,
    maxTokens: max,
    usedPercent: used !== null && max ? Math.round((used / max) * 1000) / 10 : null,
    autoCompactThreshold: threshold,
    tokensUntilCompaction:
      used !== null && threshold !== null ? Math.max(0, threshold - used) : null,
    compactionCount: compactions.length,
    contextLimitSetting: positiveOption(projection, "contextLimit"),
    compactBufferPercentSetting: positiveOption(projection, "compactBuffer"),
    updatedAt: usage?.at ?? null,
  };
}

export const layer = McpToolAccess.toLayer(ContextToolkit, {
  t3_context_read: McpToolAccess.reads(({ threadId }) =>
    Effect.gen(function* () {
      const { projection } = yield* readThread(
        threadId,
        ["providerThreads", "providerTurns", "turnItems"],
        { turnItemTypes: ["compaction"] },
      );
      return summarizeContext(projection);
    }),
  ),
});
