import { describe, expect, it } from "vite-plus/test";
import { resolveDefaultRuntimeMode, resolveSupportedRuntimeMode } from "./runtimeMode.ts";

describe("permission defaults", () => {
  const settings = {
    defaultRuntimeMode: "full-access",
    defaultRuntimeModeWithAuto: "auto",
  } as const;

  it.each([
    [["approval-required", "auto", "full-access"], "auto"],
    [["approval-required", "full-access"], "full-access"],
    [["approval-required", "auto"], "auto"],
    [["approval-required"], "approval-required"],
    [undefined, "full-access"],
    [[], "full-access"],
  ] as const)("uses advertised modes %j to choose %s", (supported, expected) => {
    expect(resolveDefaultRuntimeMode(settings, supported)).toBe(expected);
  });

  it("preserves the old default until the Auto-provider preference is set", () => {
    expect(
      resolveDefaultRuntimeMode({ ...settings, defaultRuntimeModeWithAuto: null }, [
        "auto",
        "full-access",
      ]),
    ).toBe("full-access");
  });

  it("falls back to Supervised for unsupported preferences and legacy Auto defaults", () => {
    expect(
      resolveDefaultRuntimeMode({ ...settings, defaultRuntimeModeWithAuto: "full-access" }, [
        "approval-required",
        "auto",
      ]),
    ).toBe("approval-required");
    expect(resolveDefaultRuntimeMode(settings, ["approval-required", "auto-accept-edits"])).toBe(
      "approval-required",
    );
    expect(resolveDefaultRuntimeMode({ ...settings, defaultRuntimeMode: "auto" }, undefined)).toBe(
      "approval-required",
    );
    expect(resolveSupportedRuntimeMode("auto", [])).toBe("approval-required");
  });
});
