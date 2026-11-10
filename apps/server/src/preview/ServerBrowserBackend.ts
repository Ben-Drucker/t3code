import type { PreviewAutomationRequest } from "@t3tools/contracts";

export interface ServerBrowserHistoryInput {
  readonly threadId: string;
  readonly tabId: string;
  readonly direction: "back" | "forward" | "reload";
  readonly ignoreCache?: boolean;
}

/** Both server runtimes consume the broker's authorized requests and return its existing payloads. */
export interface ServerBrowserBackend {
  readonly execute: (request: PreviewAutomationRequest) => Promise<unknown>;
  readonly history: (input: ServerBrowserHistoryInput) => Promise<unknown>;
  readonly close: () => Promise<void>;
}
