import "~/index.css";

import { expect, it, vi } from "vite-plus/test";
import type { ContextBreakdown } from "@t3tools/client-runtime/context-breakdown";
import type { ContextWindowSnapshot } from "@t3tools/client-runtime/state/context-window";

import { act, render } from "../../../test/render";
import { TooltipProvider } from "../ui/tooltip";
import { ContextWindowMeter } from "./ContextWindowMeter";
import { ThreadDetailsContext } from "./ThreadDetailsUsage";

const SAMPLE_USAGE: ContextWindowSnapshot = {
  usedTokens: 120_000,
  maxTokens: 200_000,
  remainingTokens: 80_000,
  usedPercentage: 60,
  remainingPercentage: 40,
  totalProcessedTokens: 150_000,
  compactsAutomatically: true,
  autoCompactThreshold: 160_000,
  cost: { amount: 0.42, currency: "USD" },
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const SAMPLE_BREAKDOWN: ContextBreakdown = {
  estimated: false,
  categories: [
    { category: "messages", tokens: 80_000 },
    { category: "system", tokens: 30_000 },
    { category: "reasoning", tokens: 10_000 },
  ],
};

it("renders a compaction threshold tick mark on the radial ContextWindowMeter", async () => {
  await using screen = await render(
    <ContextWindowMeter usage={SAMPLE_USAGE} breakdown={SAMPLE_BREAKDOWN} />,
    { router: false },
  );
  const tick = screen.container.querySelector('[data-testid="context-window-compact-tick"]');
  expect(tick).not.toBeNull();
});

it("omits the radial compaction tick mark when threshold is missing or >= maxTokens", async () => {
  await using screen = await render(
    <ContextWindowMeter usage={{ ...SAMPLE_USAGE, autoCompactThreshold: null }} />,
    { router: false },
  );
  expect(screen.container.querySelector('[data-testid="context-window-compact-tick"]')).toBeNull();
});

it("toggles the token breakdown and compact action when clicking ThreadDetailsContext", async () => {
  const onCompact = vi.fn();
  await using screen = await render(
    <TooltipProvider>
      <ThreadDetailsContext
        usage={SAMPLE_USAGE}
        breakdown={SAMPLE_BREAKDOWN}
        onCompact={onCompact}
      />
    </TooltipProvider>,
    { router: false },
  );

  const row = screen.container.querySelector("button")!;
  expect(row.getAttribute("aria-expanded")).toBe("false");
  expect(
    screen.container.querySelector('[data-testid="thread-details-context-breakdown"]'),
  ).toBeNull();

  await act(() => row.click());
  expect(row.getAttribute("aria-expanded")).toBe("true");
  const breakdown = screen.container.querySelector(
    '[data-testid="thread-details-context-breakdown"]',
  );
  expect(breakdown).not.toBeNull();
  expect(breakdown?.textContent).toContain("Messages");

  const compactButton = Array.from(breakdown!.querySelectorAll("button")).find((button) =>
    button.textContent?.includes("Compact context"),
  );
  expect(compactButton).toBeDefined();
  await act(() => compactButton!.click());
  expect(onCompact).toHaveBeenCalledOnce();
});
