import type { ModelCapabilities } from "@t3tools/contracts";
import { ACP_SESSION_MODE_OPTION_ID } from "@t3tools/provider-acp/server/sessionConfig";

export const KIMI_NATIVE_MODE_OPTION_IDS = ["mode", ACP_SESSION_MODE_OPTION_ID];

export function withKimiRuntimeControls(capabilities: ModelCapabilities): ModelCapabilities {
  return {
    ...capabilities,
    optionDescriptors: (capabilities.optionDescriptors ?? []).filter(
      (option) => !KIMI_NATIVE_MODE_OPTION_IDS.includes(option.id),
    ),
  };
}
