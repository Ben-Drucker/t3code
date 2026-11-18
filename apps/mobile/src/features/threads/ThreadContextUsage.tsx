import {
  deriveLatestContextWindowSnapshot,
  latestProviderTurnTokenUsage,
} from "@t3tools/client-runtime/state/context-window";
import {
  CONTEXT_BREAKDOWN_LABELS,
  resolveContextBreakdown,
} from "@t3tools/client-runtime/context-breakdown";
import { formatContextWindowTokens } from "@t3tools/shared/contextWindow";
import type { ThreadStructure } from "@t3tools/client-runtime/state/models";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { Pressable, View } from "react-native";
import Svg, { Circle, Line } from "react-native-svg";

import { AppText as Text } from "../../components/ui/AppText";
import { useUniwindTheme } from "../../lib/useUniwindTheme";
import {
  useQuietThreadStructure,
  useSelectedThreadProjection,
} from "../../state/use-thread-detail";

function activeThreadContextSnapshot(projection: ThreadStructure | undefined) {
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
  return { projection, entries, context, providerThread };
}

export function ThreadContextIndicator(props: {
  readonly threadRef: ScopedThreadRef;
  readonly onPress: () => void;
  readonly size?: "regular" | "large";
}) {
  const thread = useQuietThreadStructure(props.threadRef);
  const { context } = activeThreadContextSnapshot(thread?.projection);
  const theme = useUniwindTheme();
  if (!context) return null;

  const normalizedPercentage = Math.max(0, Math.min(100, context.usedPercentage ?? 0));
  const radius = 9.75;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference * (1 - normalizedPercentage / 100);
  const isOverloaded = normalizedPercentage > 90;
  const strokeColor = isOverloaded
    ? theme["--color-danger-foreground"]
    : theme["--color-foreground-muted"];
  const trackColor = theme["--color-subtle-strong"];
  const threshold = context.autoCompactThreshold ?? null;
  const thresholdRatio =
    context.maxTokens != null &&
    context.maxTokens > 0 &&
    threshold !== null &&
    threshold > 0 &&
    threshold < context.maxTokens
      ? threshold / context.maxTokens
      : null;
  const tickAngle = thresholdRatio !== null ? 2 * Math.PI * thresholdRatio : null;
  const buttonSize = props.size === "large" ? 36 : 30;
  const label =
    context.maxTokens !== null && context.usedPercentage !== null
      ? `Context window ${Math.round(normalizedPercentage)}% used`
      : `Context window ${formatContextWindowTokens(context.usedTokens)} tokens used`;

  return (
    <Pressable
      onPress={props.onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint="Opens thread details and context usage"
      hitSlop={4}
      style={{
        width: buttonSize,
        height: buttonSize,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <Svg width={18} height={18} viewBox="0 0 24 24" style={{ transform: [{ rotate: "-90deg" }] }}>
        <Circle cx={12} cy={12} r={radius} fill="none" stroke={trackColor} strokeWidth={3} />
        <Circle
          cx={12}
          cy={12}
          r={radius}
          fill="none"
          stroke={strokeColor}
          strokeWidth={3}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={dashOffset}
        />
        {tickAngle !== null ? (
          <Line
            x1={12 + (radius - 2.25) * Math.cos(tickAngle)}
            y1={12 + (radius - 2.25) * Math.sin(tickAngle)}
            x2={12 + (radius + 2.25) * Math.cos(tickAngle)}
            y2={12 + (radius + 2.25) * Math.sin(tickAngle)}
            stroke={theme["--color-foreground"]}
            strokeOpacity={0.7}
            strokeWidth={1.5}
            strokeLinecap="round"
          />
        ) : null}
      </Svg>
    </Pressable>
  );
}

export function ThreadContextUsage() {
  const thread = useSelectedThreadProjection();
  const { projection, entries, context, providerThread } = activeThreadContextSnapshot(
    thread?.projection,
  );
  if (!context) return null;
  const breakdown =
    providerThread?.driver === "antigravity" && !context.breakdown?.length
      ? null
      : resolveContextBreakdown({
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
      {breakdown ? (
        <Text className="text-xs text-foreground-muted">
          {breakdown.estimated ? "Estimated breakdown" : "Breakdown"}
        </Text>
      ) : null}
      {breakdown?.categories.map((row) => (
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
