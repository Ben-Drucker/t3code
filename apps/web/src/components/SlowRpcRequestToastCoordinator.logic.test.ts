import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { removeLocalStorageItem } from "../hooks/useLocalStorage";
import type { SlowRpcAckRequest } from "../rpc/requestLatencyState";
import { searchSettings } from "./settings/settingsSearch";
import {
  SLOW_REQUEST_WARNINGS_PAUSE_STORAGE_KEY,
  clampSlowRequestPauseHours,
  createTimedSlowRequestWarningsPause,
  describeSlowRequestWarningsStatus,
  isSlowRequestWarningsPaused,
  parseSlowRequestPauseHoursInput,
  pauseSlowRequestWarningsForHours,
  pauseSlowRequestWarningsForever,
  readSlowRequestWarningsPause,
  resolveActiveSlowRequestWarningsPause,
  resumeSlowRequestWarnings,
} from "./SlowRpcRequestToastCoordinator.logic";

const slowListeners = new Set<(requests: ReadonlyArray<SlowRpcAckRequest>) => void>();

vi.mock("../rpc/requestLatencyState", () => ({
  subscribeSlowRpcAckRequests: (listener: (requests: ReadonlyArray<SlowRpcAckRequest>) => void) => {
    slowListeners.add(listener);
    return () => {
      slowListeners.delete(listener);
    };
  },
}));

const toastMocks = vi.hoisted(() => ({
  add: vi.fn(() => "slow-toast-1"),
  close: vi.fn(),
  update: vi.fn(),
}));

vi.mock("./ui/toast", () => ({
  toastManager: toastMocks,
}));

function emitSlowRequests(requests: ReadonlyArray<SlowRpcAckRequest>) {
  for (const listener of slowListeners) {
    listener(requests);
  }
}

const SAMPLE_SLOW_REQUEST: SlowRpcAckRequest = {
  requestId: "req-1",
  tag: "orchestration.sendTurn",
  startedAt: "2026-11-12T07:00:00.000Z",
  startedAtMs: Date.UTC(2026, 10, 12, 7, 0, 0),
  thresholdMs: 15_000,
};

describe("SlowRpcRequestToastCoordinator pause logic", () => {
  beforeEach(() => {
    removeLocalStorageItem(SLOW_REQUEST_WARNINGS_PAUSE_STORAGE_KEY);
    slowListeners.clear();
    toastMocks.add.mockClear();
    toastMocks.close.mockClear();
    toastMocks.update.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
    removeLocalStorageItem(SLOW_REQUEST_WARNINGS_PAUSE_STORAGE_KEY);
  });

  it("evaluates isSlowRequestWarningsPaused across null, timed expiry, and forever", () => {
    const now = Date.UTC(2026, 10, 12, 12, 0, 0);

    expect(isSlowRequestWarningsPaused(null, now)).toBe(false);
    expect(isSlowRequestWarningsPaused({ kind: "forever" }, now)).toBe(true);
    expect(isSlowRequestWarningsPaused({ kind: "until", expiresAtMs: now + 1 }, now)).toBe(true);
    expect(isSlowRequestWarningsPaused({ kind: "until", expiresAtMs: now }, now)).toBe(false);
    expect(isSlowRequestWarningsPaused({ kind: "until", expiresAtMs: now - 5_000 }, now)).toBe(
      false,
    );

    expect(
      resolveActiveSlowRequestWarningsPause({ kind: "until", expiresAtMs: now - 1 }, now),
    ).toBeNull();
    expect(resolveActiveSlowRequestWarningsPause({ kind: "forever" }, now)).toEqual({
      kind: "forever",
    });
  });

  it("clamps integer hours to 1..24 and rejects non-integers", () => {
    expect(clampSlowRequestPauseHours(0)).toBe(1);
    expect(clampSlowRequestPauseHours(-8)).toBe(1);
    expect(clampSlowRequestPauseHours(1)).toBe(1);
    expect(clampSlowRequestPauseHours(12)).toBe(12);
    expect(clampSlowRequestPauseHours(24)).toBe(24);
    expect(clampSlowRequestPauseHours(72)).toBe(24);
    expect(clampSlowRequestPauseHours(Number.NaN)).toBe(1);
    expect(clampSlowRequestPauseHours(Number.POSITIVE_INFINITY)).toBe(1);

    expect(parseSlowRequestPauseHoursInput("1")).toBe(1);
    expect(parseSlowRequestPauseHoursInput(" 24 ")).toBe(24);
    expect(parseSlowRequestPauseHoursInput("0")).toBe(1);
    expect(parseSlowRequestPauseHoursInput("-3")).toBe(1);
    expect(parseSlowRequestPauseHoursInput("99")).toBe(24);

    expect(parseSlowRequestPauseHoursInput("")).toBeNull();
    expect(parseSlowRequestPauseHoursInput("   ")).toBeNull();
    expect(parseSlowRequestPauseHoursInput("1.5")).toBeNull();
    expect(parseSlowRequestPauseHoursInput("2e1")).toBeNull();
    expect(parseSlowRequestPauseHoursInput("abc")).toBeNull();
  });

  it("creates timed pauses with clamped hours and formats reverse status text", () => {
    const now = Date.UTC(2026, 10, 12, 12, 0, 0);
    const pause = createTimedSlowRequestWarningsPause(48, now);
    expect(pause).toEqual({
      kind: "until",
      expiresAtMs: now + 24 * 60 * 60 * 1_000,
    });

    expect(describeSlowRequestWarningsStatus(null, now)).toBe("On");
    expect(describeSlowRequestWarningsStatus({ kind: "forever" }, now)).toBe("Paused forever");
    expect(describeSlowRequestWarningsStatus(pause, now)).toMatch(/^Paused until /);
    expect(describeSlowRequestWarningsStatus(pause, pause.expiresAtMs)).toBe("On");
  });

  it("finds Slow request warnings in settings search", () => {
    expect(searchSettings("slow request warnings")[0]).toMatchObject({
      id: "slow-request-warnings",
      to: "/settings/general",
    });
    expect(searchSettings("waiting longer than 15s")[0]?.id).toBe("slow-request-warnings");
  });

  it("suppresses toast while paused, resumes on clear, and re-enables automatically after expiry", async () => {
    const baseNow = Date.UTC(2026, 10, 12, 12, 0, 0);
    const twoHoursMs = 2 * 60 * 60 * 1_000;
    vi.useFakeTimers();
    vi.setSystemTime(baseNow);

    const { startSlowRpcRequestToasts } = await import("./SlowRpcRequestToastCoordinator");
    const stop = startSlowRpcRequestToasts();

    try {
      emitSlowRequests([SAMPLE_SLOW_REQUEST]);
      expect(toastMocks.add).toHaveBeenCalledTimes(1);

      pauseSlowRequestWarningsForHours(2, baseNow);
      expect(readSlowRequestWarningsPause(baseNow)).toEqual({
        kind: "until",
        expiresAtMs: baseNow + twoHoursMs,
      });
      expect(toastMocks.close).toHaveBeenCalledWith("slow-toast-1");

      emitSlowRequests([SAMPLE_SLOW_REQUEST]);
      expect(toastMocks.add).toHaveBeenCalledTimes(1);

      // Advance past the 2-hour pause while the slow request is still waiting: toast reappears automatically.
      vi.advanceTimersByTime(twoHoursMs + 50);
      expect(readSlowRequestWarningsPause(baseNow + twoHoursMs + 50)).toBeNull();
      expect(toastMocks.add).toHaveBeenCalledTimes(2);

      // Forever pause suppresses until explicitly resumed.
      pauseSlowRequestWarningsForever();
      expect(toastMocks.close).toHaveBeenCalledTimes(2);

      resumeSlowRequestWarnings();
      expect(toastMocks.add).toHaveBeenCalledTimes(3);
    } finally {
      stop();
    }
  });
});
