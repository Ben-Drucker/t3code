import type { RuntimeMode } from "@t3tools/contracts";

export function supportedRuntimeModeChoices(
  supported: ReadonlyArray<RuntimeMode> | undefined,
): ReadonlyArray<RuntimeMode> {
  return supported && supported.length > 0
    ? supported
    : ["approval-required", "auto-accept-edits", "full-access"];
}

export function resolveSupportedRuntimeMode(
  mode: RuntimeMode,
  supported: ReadonlyArray<RuntimeMode> | undefined,
): RuntimeMode {
  return supportedRuntimeModeChoices(supported).includes(mode) ? mode : "approval-required";
}

export function resolveDefaultRuntimeMode(
  settings: {
    readonly defaultRuntimeMode: RuntimeMode;
    readonly defaultRuntimeModeWithAuto: RuntimeMode | null;
  },
  supported: ReadonlyArray<RuntimeMode> | undefined,
): RuntimeMode {
  const preferred = supported?.includes("auto")
    ? (settings.defaultRuntimeModeWithAuto ?? settings.defaultRuntimeMode)
    : settings.defaultRuntimeMode;
  return resolveSupportedRuntimeMode(preferred, supported);
}
