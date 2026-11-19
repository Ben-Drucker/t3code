import type { EnvironmentId, ModelSelection, RecentModelConfiguration } from "@t3tools/contracts";
import {
  readRecentModelConfigurations,
  rememberRecentModelConfiguration,
} from "@t3tools/shared/model";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { resolveStorage } from "./lib/storage";

type ModelRecentState = { recent: ReadonlyArray<RecentModelConfiguration> };

export const useModelRecents = create<ModelRecentState>()(
  persist<ModelRecentState>(() => ({ recent: [] }), {
    name: "t3code:model-recents",
    storage: createJSONStorage(() =>
      resolveStorage(typeof window === "undefined" ? undefined : window.localStorage),
    ),
    merge: (stored, current) => ({
      ...current,
      recent: readRecentModelConfigurations(
        typeof stored === "object" && stored !== null && "recent" in stored ? stored.recent : null,
      ),
    }),
  }),
);

export function recordModelRecent(environmentId: EnvironmentId, selection: ModelSelection) {
  try {
    useModelRecents.setState(({ recent }) => ({
      recent: rememberRecentModelConfiguration(recent, { environmentId, selection }),
    }));
  } catch {
    // A storage quota can prevent saving history after the selection has already been applied.
  }
}
