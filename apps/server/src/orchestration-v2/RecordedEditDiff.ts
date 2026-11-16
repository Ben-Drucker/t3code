import type { OrchestrationV2TurnItem } from "@t3tools/contracts";
import { structuredPatch, formatPatch, parsePatch, FILE_HEADERS_ONLY } from "diff";

const cache = new WeakMap<OrchestrationV2TurnItem, OrchestrationV2TurnItem>();
function parseRecordedPatch(patch: string, fallbackFileName?: string) {
  const tryParse = (input: string) => {
    try {
      return parsePatch(input);
    } catch {
      return null;
    }
  };
  const direct = tryParse(patch);
  if (direct && direct.some((file) => file.hunks.length > 0)) return direct;
  const trimmed = patch.replace(/\n+$/, "");
  if (trimmed.trimStart().startsWith("@@ ") && fallbackFileName) {
    const withHeaders = tryParse(`--- ${fallbackFileName}\n+++ ${fallbackFileName}\n${trimmed}`);
    if (withHeaders && withHeaders.some((file) => file.hunks.length > 0)) return withHeaders;
  }
  if (trimmed !== patch) {
    const withoutTrailing = tryParse(trimmed);
    if (withoutTrailing && withoutTrailing.some((file) => file.hunks.length > 0)) {
      return withoutTrailing;
    }
  }
  return direct ?? [];
}

function patchMatchesChangePath(
  file: ReturnType<typeof parsePatch>[number],
  changePath: string,
): boolean {
  const candidates = [file.newFileName, file.oldFileName].flatMap((name) =>
    name && name !== "/dev/null" ? [name, name.replace(/^[ab]\//, "")] : [],
  );
  if (candidates.some((name) => name === changePath)) return true;
  return candidates.some(
    (name) => changePath.endsWith(`/${name}`) || name.endsWith(`/${changePath}`),
  );
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
  let files = parseRecordedPatch(patch ?? "", item.fileName);
  const change = item.changes?.length === 1 ? item.changes[0] : undefined;
  const isAddOperation = change?.operation === "add" || change?.operation === "create";
  const isWriteWithoutBefore =
    item.oldStr === undefined &&
    item.newStr !== undefined &&
    (change === undefined || isAddOperation);
  const before = item.oldStr ?? (isWriteWithoutBefore ? "" : undefined);
  const after = item.newStr ?? (change?.operation === "delete" ? "" : undefined);
  if (!files.some((file) => file.hunks.length > 0) && before !== undefined && after !== undefined) {
    const wholeFile = isWriteWithoutBefore || change?.operation === "delete";
    let structured = structuredPatch(
      isWriteWithoutBefore ? "/dev/null" : item.fileName,
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
    files = parseRecordedPatch(patch, item.fileName);
  }
  if (!patch?.trim()) {
    if (
      item.changes &&
      item.changes.length > 0 &&
      item.changes.every((entry) => entry.additions !== undefined && entry.deletions !== undefined)
    ) {
      return {
        ...item,
        additions:
          item.additions ?? item.changes.reduce((sum, entry) => sum + (entry.additions ?? 0), 0),
        deletions:
          item.deletions ?? item.changes.reduce((sum, entry) => sum + (entry.deletions ?? 0), 0),
      };
    }
    return item;
  }
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
    const changes = item.changes?.map((entry) => {
      const file =
        files.find((candidate) => patchMatchesChangePath(candidate, entry.path)) ??
        (files.length === 1 && item.changes?.length === 1 ? files[0] : undefined);
      if (!file) return entry;
      const lines = file.hunks.flatMap((hunk) => hunk.lines);
      return {
        ...entry,
        additions: entry.additions ?? lines.filter((line) => line.startsWith("+")).length,
        deletions: entry.deletions ?? lines.filter((line) => line.startsWith("-")).length,
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
