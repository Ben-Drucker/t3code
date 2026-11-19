import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import { createContext, useContext, useState } from "react";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { render } from "../../../test/render";
import type { ScopedSettingsPatch } from "./scopedSettings";
import { DiffsSettingsPanel } from "./SettingsPanels";
import "~/index.css";

const fixtureContext = createContext({
  settings: DEFAULT_UNIFIED_SETTINGS,
  update: (_patch: ScopedSettingsPatch) => {},
});
vi.mock(import("./useScopedSettings"), async (original) => ({
  ...(await original()),
  useScopedSettings: <T = typeof DEFAULT_UNIFIED_SETTINGS,>(
    selector?: (settings: typeof DEFAULT_UNIFIED_SETTINGS) => T,
  ): T => {
    const { settings } = useContext(fixtureContext);
    return selector ? selector(settings) : (settings as T);
  },
  useUpdateScopedSettings: () => useContext(fixtureContext).update,
}));

function DiffsFixture() {
  const [settings, setSettings] = useState(DEFAULT_UNIFIED_SETTINGS);
  const update = ({ diffColorScheme }: ScopedSettingsPatch) => {
    if (!diffColorScheme) return;
    document.documentElement.dataset.diffColorScheme = diffColorScheme;
    setSettings((previous) => ({ ...previous, diffColorScheme }));
  };
  return (
    <fixtureContext.Provider value={{ settings, update }}>
      <div>
        <DiffsSettingsPanel />
        <span className="text-diff-addition-foreground">+3</span>
        <span className="text-diff-deletion-foreground">−2</span>
      </div>
    </fixtureContext.Provider>
  );
}

it("chooses Lime & rust and applies it to counts and the diff renderer", async () => {
  const { dataset } = document.documentElement;
  const previousScheme = dataset.diffColorScheme;
  using _restoreScheme = {
    [Symbol.dispose]() {
      if (previousScheme === undefined) delete dataset.diffColorScheme;
      else dataset.diffColorScheme = previousScheme;
    },
  };
  await using screen = await render(<DiffsFixture />);
  const picker = screen.getByRole("combobox", { name: "Diff colors" });
  await expect.element(picker).toHaveTextContent("Red & green");
  await userEvent.click(picker);
  await expect.element(screen.getByRole("option", { name: "Blue & orange" })).toBeVisible();
  await userEvent.click(screen.getByRole("option", { name: "Lime & rust" }));
  await expect.element(picker).toHaveTextContent("Lime & rust");
  const additions = getComputedStyle(screen.getByText("+3", { exact: true }).element());
  const deletions = getComputedStyle(screen.getByText("−2", { exact: true }).element());
  expect(additions.color).toBe("rgb(91, 237, 43)");
  expect(deletions.color).toBe("rgb(173, 60, 31)");
  expect(additions.getPropertyValue("--diffs-addition-color-override").trim()).toBe("#5bed2b");
  expect(deletions.getPropertyValue("--diffs-deletion-color-override").trim()).toBe("#ad3c1f");
});
