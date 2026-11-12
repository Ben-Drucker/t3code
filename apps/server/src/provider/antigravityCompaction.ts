import type { ModelCapabilities } from "@t3tools/contracts";

export const ANTIGRAVITY_CONTEXT_LIMIT = 256_000;

export function withAntigravityContextControls(capabilities: ModelCapabilities): ModelCapabilities {
  return {
    ...capabilities,
    optionDescriptors: [
      ...(capabilities.optionDescriptors ?? []).filter(
        (descriptor) => descriptor.id !== "contextLimit" && descriptor.id !== "compactBuffer",
      ),
      {
        id: "contextLimit",
        label: "Context limit",
        type: "select",
        disabledReason: "Fixed by Antigravity",
        currentValue: String(ANTIGRAVITY_CONTEXT_LIMIT),
        options: [{ id: String(ANTIGRAVITY_CONTEXT_LIMIT), label: "256K", isDefault: true }],
      },
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
