import type { ModelCapabilities } from "@t3tools/contracts";

export function withAntigravityContextControls(capabilities: ModelCapabilities): ModelCapabilities {
  return {
    ...capabilities,
    optionDescriptors: [
      ...(capabilities.optionDescriptors ?? []).filter(
        (descriptor) => descriptor.id !== "contextLimit" && descriptor.id !== "compactBuffer",
      ),
      {
        id: "compactBuffer",
        label: "Compaction",
        type: "select",
        disabledReason: "Fixed by Antigravity",
        currentValue: "auto",
        options: [{ id: "auto", label: "Auto", isDefault: true }],
      },
    ],
  };
}
