import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { render } from "../../test/render";
import { removeLocalStorageItem } from "../hooks/useLocalStorage";
import { type SlowRpcAckRequest, subscribeSlowRpcAckRequests } from "../rpc/requestLatencyState";
import { SlowRequestWarningsSettingsRow } from "./settings/NotificationSettings";
import { startSlowRpcRequestToasts } from "./SlowRpcRequestToastCoordinator";
import {
  SLOW_REQUEST_WARNINGS_PAUSE_STORAGE_KEY,
  readSlowRequestWarningsPause,
} from "./SlowRpcRequestToastCoordinator.logic";
import { ToastProvider } from "./ui/toast";

vi.mock("../rpc/requestLatencyState", { spy: true });

const slowListeners = new Set<(requests: ReadonlyArray<SlowRpcAckRequest>) => void>();

function emitSlowRequests(requests: ReadonlyArray<SlowRpcAckRequest>) {
  for (const listener of slowListeners) {
    listener(requests);
  }
}

const SAMPLE_SLOW_REQUEST: SlowRpcAckRequest = {
  requestId: "req-browser-1",
  tag: "orchestration.sendTurn",
  startedAt: "2026-11-12T07:00:00.000Z",
  startedAtMs: Date.UTC(2026, 10, 12, 7, 0, 0),
  thresholdMs: 15_000,
};

function acquireSlowToastTestHarness() {
  removeLocalStorageItem(SLOW_REQUEST_WARNINGS_PAUSE_STORAGE_KEY);
  slowListeners.clear();
  vi.mocked(subscribeSlowRpcAckRequests).mockImplementation((listener) => {
    slowListeners.add(listener);
    return () => {
      slowListeners.delete(listener);
    };
  });
  const stop = startSlowRpcRequestToasts();
  return {
    [Symbol.dispose]() {
      stop();
      slowListeners.clear();
      vi.restoreAllMocks();
      removeLocalStorageItem(SLOW_REQUEST_WARNINGS_PAUSE_STORAGE_KEY);
    },
  };
}

describe("SlowRpcRequestToastCoordinator browser UI", () => {
  it("pauses from the toast with validated hours or forever and resumes from Settings", async () => {
    using _harness = acquireSlowToastTestHarness();
    await using _screen = await render(
      <ToastProvider>
        <SlowRequestWarningsSettingsRow />
      </ToastProvider>,
    );

    await expect.element(page.getByText("Slow request warnings")).toBeVisible();
    await expect.element(page.getByText("On", { exact: true })).toBeVisible();

    emitSlowRequests([SAMPLE_SLOW_REQUEST]);

    await expect.element(page.getByText("Some requests are slow")).toBeVisible();
    await expect.element(page.getByText("1 request waiting longer than 15s.")).toBeVisible();

    const hoursInput = page.getByLabelText("Pause hours");
    const pauseButton = page.getByRole("button", { name: "Pause", exact: true });

    // Non-integer input disables the Pause button.
    await hoursInput.fill("1.5");
    await expect.element(pauseButton).toBeDisabled();

    // Out-of-range integer clamps to 24 hours on submit and dismisses the toast.
    await hoursInput.fill("72");
    await expect.element(pauseButton).toBeEnabled();
    await pauseButton.click();

    expect(readSlowRequestWarningsPause()?.kind).toBe("until");
    await expect.element(page.getByText(/^Paused until /)).toBeVisible();

    const resumeButton = page.getByRole("button", { name: "Resume", exact: true });
    await resumeButton.click();

    expect(readSlowRequestWarningsPause()).toBeNull();
    await expect.element(page.getByText("On", { exact: true })).toBeVisible();
    await expect.element(page.getByText("Some requests are slow")).toBeVisible();

    // Pausing forever updates Settings to "Paused forever" until resumed.
    await page.getByRole("button", { name: "Forever", exact: true }).click();
    expect(readSlowRequestWarningsPause()).toEqual({ kind: "forever" });
    await expect.element(page.getByText("Paused forever")).toBeVisible();
  });
});
