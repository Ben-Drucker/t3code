import { describe, expect, it } from "@effect/vitest";
import type { ServerProvider } from "@t3tools/contracts";

import { matchesProvider, summarize, withRemaining } from "./handlers.ts";

const provider = (fields: Record<string, unknown>) => fields as unknown as ServerProvider;

describe("usage tool helpers", () => {
  it("matches an instance id, a driver, or a display name regardless of case", () => {
    const codex = provider({ instanceId: "codex_work", driver: "codex", displayName: "Work" });
    expect(matchesProvider(codex, "CODEX_WORK")).toBe(true);
    expect(matchesProvider(codex, "codex")).toBe(true);
    expect(matchesProvider(codex, " work ")).toBe(true);
    expect(matchesProvider(codex, "claudeAgent")).toBe(false);
  });

  it("adds the remaining percent to every window", () => {
    const limits = withRemaining({
      checkedAt: "2026-11-07T00:00:00.000Z",
      windows: [
        { id: "5h", kind: "session", label: "5 hour", usedPercent: 37.5 },
        { id: "week", kind: "weekly", label: "Weekly", usedPercent: 100 },
      ],
    } as never);
    expect(limits.windows.map((window) => window.remainingPercent)).toEqual([62.5, 0]);
  });

  it("flags providers that report quota windows", () => {
    const base = {
      instanceId: "a",
      driver: "codex",
      enabled: true,
      installed: true,
      status: "ready",
    };
    expect(summarize(provider({ ...base, usageLimits: { windows: [{}] } })).hasUsageLimits).toBe(
      true,
    );
    expect(summarize(provider(base)).hasUsageLimits).toBe(false);
  });
});
