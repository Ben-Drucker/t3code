import {
  deriveLatestContextWindowSnapshot,
  latestProviderTurnTokenUsage,
} from "@t3tools/client-runtime/state/context-window";
import {
  CONTEXT_BREAKDOWN_LABELS,
  resolveContextBreakdown,
} from "@t3tools/client-runtime/context-breakdown";
import { formatContextWindowTokens } from "@t3tools/shared/contextWindow";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { useSelectedThreadProjection } from "../../state/use-thread-detail";

export function ThreadContextUsage() {
  const thread = useSelectedThreadProjection();
  const projection = thread?.projection;
  const providerThread = projection?.providerThreads.find(
    (candidate) => candidate.id === projection.thread.activeProviderThreadId,
  );
  const liveUsage = latestProviderTurnTokenUsage(
    projection?.providerTurns ?? [],
    projection,
    providerThread,
  );
  const entries = projection?.visibleTurnItems ?? [];
  const context = deriveLatestContextWindowSnapshot(entries, liveUsage, providerThread);
  if (!context) return null;
  const breakdown = resolveContextBreakdown({
    reported: context.breakdown,
    entries,
    messageChars:
      projection?.messages.reduce((count, message) => count + message.text.length, 0) ?? 0,
    usedTokens: context.usedTokens ?? 0,
    reportedReasoningTokens: context.reasoningOutputTokens,
  });
  const used = formatContextWindowTokens(context.usedTokens);
  const limit =
    context.maxTokens == null ? "Unknown" : formatContextWindowTokens(context.maxTokens);
  return (
    <View className="mx-4 mb-4 gap-3 rounded-2xl bg-grouped-card p-4">
      <View className="flex-row justify-between gap-4">
        <Text className="text-sm text-foreground">Context</Text>
        <Text className="text-sm text-foreground-secondary">
          {used} / {limit}
        </Text>
      </View>
      {context.usedPercentage !== null ? (
        <View
          accessibilityRole="progressbar"
          accessibilityLabel="Context used"
          accessibilityValue={{
            min: 0,
            max: 100,
            now: context.usedPercentage,
            text: `${used} of ${limit} tokens`,
          }}
          className="h-1 overflow-hidden rounded-full bg-subtle-strong"
        >
          <View className="h-full bg-primary" style={{ width: `${context.usedPercentage}%` }} />
        </View>
      ) : null}
      <Text className="text-xs text-foreground-muted">
        {breakdown.estimated ? "Estimated breakdown" : "Breakdown"}
      </Text>
      {breakdown.categories.map((row) => (
        <View key={row.category} className="flex-row justify-between gap-4">
          <Text className="text-xs text-foreground-muted">
            {CONTEXT_BREAKDOWN_LABELS[row.category]}
          </Text>
          <Text className="text-xs text-foreground-muted">
            {formatContextWindowTokens(row.tokens)}
          </Text>
        </View>
      ))}
    </View>
  );
}
