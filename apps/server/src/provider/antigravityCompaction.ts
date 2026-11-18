import type { ModelCapabilities } from "@t3tools/contracts";

export function antigravityContextWindow(model: string): number {
  return /(?:^|[^a-z0-9])gemini[- _.]?4(?:[^0-9]|$)/i.test(model) ? 512_000 : 256_000;
}

export function withAntigravityContextControls(
  capabilities: ModelCapabilities,
  model: string,
): ModelCapabilities {
  const contextWindow = antigravityContextWindow(model);
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
        disabledReason: "Fixed for Antigravity models",
        currentValue: String(contextWindow),
        options: [
          { id: String(contextWindow), label: `${contextWindow / 1000}K`, isDefault: true },
        ],
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
