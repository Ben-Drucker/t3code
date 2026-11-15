import { useMemo, useState } from "react";
import { Modal, Pressable, View, StyleSheet } from "react-native";
import { AppText as Text } from "../../components/ui/AppText";
import { resolveNativeReviewDiffView } from "../diffs/nativeReviewDiffSurface";
import { buildReviewParsedDiff } from "../review/reviewModel";
import {
  buildNativeReviewDiffData,
  NATIVE_REVIEW_DIFF_CONTENT_WIDTH,
} from "../review/nativeReviewDiffAdapter";
import { useAppearanceCodeSurface } from "../settings/appearance/useAppearanceCodeSurface";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import { useNativeReviewDiffBridge } from "../review/useNativeReviewDiffBridge";
const EMPTY_IDS: readonly string[] = [];

export function RecordedToolDiff({ patch }: { patch: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Pressable accessibilityRole="button" onPress={() => setOpen(true)} className="py-2">
        <Text className="text-primary">Open diff</Text>
      </Pressable>
      <Modal visible={open} onRequestClose={() => setOpen(false)} animationType="none">
        {open && <RecordedDiffSurface patch={patch} onClose={() => setOpen(false)} />}
      </Modal>
    </>
  );
}

function RecordedDiffSurface({ patch, onClose }: { patch: string; onClose: () => void }) {
  const [NativeDiff] = useState(() => resolveNativeReviewDiffView());
  const [collapsedFiles, setCollapsedFiles] = useState<readonly string[]>(EMPTY_IDS);
  const { nativeReviewDiffStyle } = useAppearanceCodeSurface();
  const { themeAppearance } = useAppearancePreferences();
  const data = useMemo(
    () => buildNativeReviewDiffData(buildReviewParsedDiff(patch, "recorded-tool")),
    [patch],
  );
  const bridge = useNativeReviewDiffBridge({
    threadKey: "recorded-tool",
    sectionId: "recorded-tool",
    diff: patch,
    data,
    collapsedFileIds: collapsedFiles,
    viewedFileIds: EMPTY_IDS,
    selectedRowIds: EMPTY_IDS,
    canHighlight: true,
  });
  return (
    <View className="flex-1 bg-background pt-12">
      <Pressable accessibilityRole="button" onPress={onClose} className="p-4">
        <Text>Close diff</Text>
      </Pressable>
      <View className="flex-1">
        {NativeDiff ? (
          <NativeDiff
            style={StyleSheet.absoluteFill}
            appearanceScheme={themeAppearance}
            contentWidth={NATIVE_REVIEW_DIFF_CONTENT_WIDTH}
            rowHeight={nativeReviewDiffStyle.rowHeight}
            rowsJson={bridge.rowsJson}
            collapsedFileIdsJson={bridge.collapsedFileIdsJson}
            onToggleFile={(event) => {
              const id = event.nativeEvent.fileId;
              if (id)
                setCollapsedFiles((files) =>
                  files.includes(id) ? files.filter((file) => file !== id) : [...files, id],
                );
            }}
            tokensResetKey={bridge.tokensResetKey}
            tokensPatchJson={bridge.tokensPatchJson}
            onDebug={bridge.onDebug}
            styleJson={bridge.styleJson}
            themeJson={bridge.themeJson}
          />
        ) : (
          <Text>The diff viewer is unavailable in this client.</Text>
        )}
      </View>
    </View>
  );
}
