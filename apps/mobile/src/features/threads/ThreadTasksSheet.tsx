import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { deriveTasksPanelModel, formatStepDuration } from "@t3tools/shared/tasksPanel";
import { ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/ui/AppText";
import { SheetHeader } from "../../components/ui/SheetHeader";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { useQuietThreadStructure } from "../../state/use-thread-detail";

const STATUS_LABEL = {
  pending: "Pending",
  running: "In progress",
  completed: "Completed",
} as const;

export function ThreadTasksSheet({
  route,
}: StaticScreenProps<{
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}>) {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const structure = useQuietThreadStructure(route.params);
  const model = deriveTasksPanelModel(structure?.projection.plans ?? []);
  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      <SheetHeader title="Tasks" onClose={() => navigation.goBack()} />
      <ScreenContent>
        <ScrollView
          className="flex-1"
          contentInsetAdjustmentBehavior="automatic"
          contentContainerClassName="gap-4 px-5 pt-4"
          contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 16) + 8 }}
        >
          {!model || model.total === 0 ? (
            <Text className="text-sm text-foreground-muted">No tasks yet.</Text>
          ) : (
            <>
              <Text className="text-sm text-foreground">
                {model.completed}/{model.total} done
              </Text>
              <View
                accessibilityRole="progressbar"
                accessibilityLabel="Tasks completed"
                accessibilityValue={{ min: 0, max: model.total, now: model.completed }}
                className="h-1 overflow-hidden rounded-full bg-subtle-strong"
              >
                <View
                  className="h-full bg-primary"
                  style={{ width: `${(model.completed / model.total) * 100}%` }}
                />
              </View>
              {model.explanation ? (
                <Text className="text-sm text-foreground-muted">{model.explanation}</Text>
              ) : null}
              {model.steps.map((step) => (
                <View key={step.id} className="gap-1 border-b border-border pb-4">
                  <Text
                    className={
                      step.status === "completed"
                        ? "text-sm text-foreground-muted line-through"
                        : "text-sm text-foreground"
                    }
                  >
                    {step.text}
                  </Text>
                  <View className="flex-row justify-between gap-4">
                    <Text className="text-xs text-foreground-muted">
                      {STATUS_LABEL[step.status]}
                    </Text>
                    <Text className="text-xs text-foreground-muted">
                      {formatStepDuration(step.durationMs)}
                    </Text>
                  </View>
                </View>
              ))}
            </>
          )}
        </ScrollView>
      </ScreenContent>
    </View>
  );
}
