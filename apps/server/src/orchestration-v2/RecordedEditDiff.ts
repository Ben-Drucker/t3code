import type { OrchestrationV2TurnItem } from "@t3tools/contracts";
import { structuredPatch, formatPatch, parsePatch, FILE_HEADERS_ONLY } from "diff";

const cache = new WeakMap<OrchestrationV2TurnItem, OrchestrationV2TurnItem>();
function parseRecordedPatch(patch: string) {
  try {
    return parsePatch(patch);
  } catch {
    return [];
  }
}
export function recordedEditDiff(item: OrchestrationV2TurnItem): OrchestrationV2TurnItem {
  const cached = cache.get(item);
  if (cached) return cached;
  const result = computeRecordedEditDiff(item);
  cache.set(item, result);
  return result;
}
function computeRecordedEditDiff(item: OrchestrationV2TurnItem): OrchestrationV2TurnItem {
  if (item.type !== "file_change" || item.status !== "completed") return item;
  if (
    [item.oldStr, item.newStr, item.diffStr].some((text) =>
      text?.endsWith("\n… output truncated for transport"),
    )
  )
    return item;
  let patch = item.diffStr;
  let files = parseRecordedPatch(patch ?? "");
  const change = item.changes?.length === 1 ? item.changes[0] : undefined;
  const before = item.oldStr ?? (change?.operation === "add" ? "" : undefined);
  const after = item.newStr ?? (change?.operation === "delete" ? "" : undefined);
  if (!files.some((file) => file.hunks.length > 0) && before !== undefined && after !== undefined) {
    const wholeFile = change?.operation === "add" || change?.operation === "delete";
    let structured = structuredPatch(
      change?.operation === "add" ? "/dev/null" : item.fileName,
      change?.operation === "delete" ? "/dev/null" : item.fileName,
      before,
      after,
      undefined,
      undefined,
      { context: 3, ...(before.length && after.length ? { maxEditLength: 1000 } : {}) },
    );
    if (structured === undefined) {
      // A replacement hunk stays linear when a minimal edit search exceeds its budget.
      const removed = structuredPatch(
        item.fileName,
        item.fileName,
        before,
        "",
        undefined,
        undefined,
        { context: 0 },
      );
      const added = structuredPatch(item.fileName, item.fileName, "", after, undefined, undefined, {
        context: 0,
      });
      const removal = removed.hunks[0];
      const addition = added.hunks[0];
      if (!removal || !addition) return item;
      structured = {
        ...removed,
        hunks: [
          {
            ...removal,
            newStart: addition.newStart,
            newLines: addition.newLines,
            lines: [...removal.lines, ...addition.lines],
          },
        ],
      };
    }
    patch = formatPatch(structured, FILE_HEADERS_ONLY);
    if (!wholeFile)
      patch = patch.replace(/(@@[^\n]*@@)/g, "$1 recorded replacement; source line unknown");
    files = parseRecordedPatch(patch);
  }
  if (!patch?.trim()) return item;
  try {
    if (files.length === 0) return { ...item, diffStr: patch };
    let additions = 0;
    let deletions = 0;
    for (const file of files)
      for (const hunk of file.hunks)
        for (const line of hunk.lines) {
          if (line.startsWith("+")) additions++;
          if (line.startsWith("-")) deletions++;
        }
    const changes = item.changes?.map((change) => {
      const file = files.find((file) =>
        [file.newFileName, file.oldFileName].some(
          (name) => name === change.path || name?.replace(/^[ab]\//, "") === change.path,
        ),
      );
      if (!file) return change;
      const lines = file.hunks.flatMap((hunk) => hunk.lines);
      return {
        ...change,
        additions: change.additions ?? lines.filter((line) => line.startsWith("+")).length,
        deletions: change.deletions ?? lines.filter((line) => line.startsWith("-")).length,
      };
    });
    return {
      ...item,
      diffStr: patch,
      additions: item.additions ?? additions,
      deletions: item.deletions ?? deletions,
      ...(changes ? { changes } : {}),
    };
  } catch {
    return item;
  }
}
