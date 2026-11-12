import * as Schema from "effect/Schema";
import { useSyncExternalStore } from "react";

import {
  readLocalStorageValue,
  subscribeLocalStorageKey,
  writeLocalStorageValue,
} from "../hooks/useLocalStorage";

export const MIN_SLOW_REQUEST_PAUSE_HOURS = 1;
export const MAX_SLOW_REQUEST_PAUSE_HOURS = 24;
export const DEFAULT_SLOW_REQUEST_PAUSE_HOURS = 1;

const HOUR_MS = 60 * 60 * 1_000;
const EXPIRY_TIMER_BUFFER_MS = 15;

export const SLOW_REQUEST_WARNINGS_PAUSE_STORAGE_KEY = "t3code:slow-request-warnings-pause:v1";

export const SlowRequestWarningsPauseState = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("until"),
    expiresAtMs: Schema.Number.check(Schema.isFinite()),
  }),
  Schema.Struct({
    kind: Schema.Literal("forever"),
  }),
]);
export type SlowRequestWarningsPauseState = typeof SlowRequestWarningsPauseState.Type;

const NullableSlowRequestWarningsPauseState = Schema.NullOr(SlowRequestWarningsPauseState);

export function clampSlowRequestPauseHours(hours: number): number {
  if (!Number.isFinite(hours)) {
    return DEFAULT_SLOW_REQUEST_PAUSE_HOURS;
  }
  const truncated = Math.trunc(hours);
  return Math.min(MAX_SLOW_REQUEST_PAUSE_HOURS, Math.max(MIN_SLOW_REQUEST_PAUSE_HOURS, truncated));
}

/**
 * Parses user-entered hours text. Rejects empty strings and non-integers (`null`),
 * and clamps integer values into `[1, 24]`.
 */
export function parseSlowRequestPauseHoursInput(raw: string): number | null {
  const trimmed = raw.trim();
  if (!/^-?\d+$/.test(trimmed)) {
    return null;
  }
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isSafeInteger(parsed)) {
    return null;
  }
  return clampSlowRequestPauseHours(parsed);
}

export function createTimedSlowRequestWarningsPause(
  hours: number,
  nowMs: number = Date.now(),
): Extract<SlowRequestWarningsPauseState, { readonly kind: "until" }> {
  const clampedHours = clampSlowRequestPauseHours(hours);
  return {
    kind: "until",
    expiresAtMs: nowMs + clampedHours * HOUR_MS,
  };
}

export function isSlowRequestWarningsPaused(
  pause: SlowRequestWarningsPauseState | null,
  nowMs: number = Date.now(),
): boolean {
  if (pause === null) {
    return false;
  }
  if (pause.kind === "forever") {
    return true;
  }
  return pause.expiresAtMs > nowMs;
}

export function resolveActiveSlowRequestWarningsPause(
  pause: SlowRequestWarningsPauseState | null,
  nowMs: number = Date.now(),
): SlowRequestWarningsPauseState | null {
  return isSlowRequestWarningsPaused(pause, nowMs) ? pause : null;
}

function isSameLocalDay(leftMs: number, rightMs: number): boolean {
  const left = new Date(leftMs);
  const right = new Date(rightMs);
  return (
    left.getFullYear() === right.getFullYear() &&
    left.getMonth() === right.getMonth() &&
    left.getDate() === right.getDate()
  );
}

function formatPauseExpiry(expiresAtMs: number, nowMs: number): string {
  const date = new Date(expiresAtMs);
  if (isSameLocalDay(expiresAtMs, nowMs)) {
    return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }
  return date.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function describeSlowRequestWarningsStatus(
  pause: SlowRequestWarningsPauseState | null,
  nowMs: number = Date.now(),
): string {
  const active = resolveActiveSlowRequestWarningsPause(pause, nowMs);
  if (active === null) {
    return "On";
  }
  if (active.kind === "forever") {
    return "Paused forever";
  }
  return `Paused until ${formatPauseExpiry(active.expiresAtMs, nowMs)}`;
}

let cachedSnapshotPause: SlowRequestWarningsPauseState | null = null;

function samePauseState(
  left: SlowRequestWarningsPauseState | null,
  right: SlowRequestWarningsPauseState | null,
): boolean {
  if (left === right) return true;
  if (left === null || right === null) return false;
  if (left.kind === "forever" && right.kind === "forever") return true;
  return left.kind === "until" && right.kind === "until" && left.expiresAtMs === right.expiresAtMs;
}

export function readSlowRequestWarningsPause(
  nowMs: number = Date.now(),
): SlowRequestWarningsPauseState | null {
  const stored = readLocalStorageValue(
    SLOW_REQUEST_WARNINGS_PAUSE_STORAGE_KEY,
    null,
    NullableSlowRequestWarningsPauseState,
  );
  const active = resolveActiveSlowRequestWarningsPause(stored, nowMs);
  if (!samePauseState(cachedSnapshotPause, active)) {
    cachedSnapshotPause = active;
  }
  return cachedSnapshotPause;
}

const fallbackListeners = new Set<() => void>();

function writeSlowRequestWarningsPause(pause: SlowRequestWarningsPauseState | null): void {
  writeLocalStorageValue(
    SLOW_REQUEST_WARNINGS_PAUSE_STORAGE_KEY,
    pause,
    null,
    NullableSlowRequestWarningsPauseState,
  );
  if (typeof window === "undefined") {
    for (const listener of fallbackListeners) {
      listener();
    }
  }
}

export function pauseSlowRequestWarningsForHours(
  hours: number,
  nowMs: number = Date.now(),
): SlowRequestWarningsPauseState {
  const next = createTimedSlowRequestWarningsPause(hours, nowMs);
  writeSlowRequestWarningsPause(next);
  return next;
}

export function pauseSlowRequestWarningsForever(): void {
  writeSlowRequestWarningsPause({ kind: "forever" });
}

export function resumeSlowRequestWarnings(): void {
  writeSlowRequestWarningsPause(null);
}

export function subscribeSlowRequestWarningsPause(onChange: () => void): () => void {
  let expiryTimer: ReturnType<typeof setTimeout> | null = null;

  const clearExpiryTimer = () => {
    if (expiryTimer !== null) {
      clearTimeout(expiryTimer);
      expiryTimer = null;
    }
  };

  const armExpiryTimer = () => {
    clearExpiryTimer();
    const stored = readLocalStorageValue(
      SLOW_REQUEST_WARNINGS_PAUSE_STORAGE_KEY,
      null,
      NullableSlowRequestWarningsPauseState,
    );
    if (stored?.kind !== "until") {
      return;
    }
    const remainingMs = stored.expiresAtMs - Date.now();
    if (remainingMs <= 0) {
      return;
    }
    expiryTimer = setTimeout(() => {
      expiryTimer = null;
      armExpiryTimer();
      onChange();
    }, remainingMs + EXPIRY_TIMER_BUFFER_MS);
  };

  const handleStorageChange = () => {
    armExpiryTimer();
    onChange();
  };

  armExpiryTimer();
  fallbackListeners.add(handleStorageChange);

  const unsubscribeStorage =
    typeof window !== "undefined"
      ? subscribeLocalStorageKey(SLOW_REQUEST_WARNINGS_PAUSE_STORAGE_KEY, handleStorageChange)
      : () => undefined;

  return () => {
    clearExpiryTimer();
    fallbackListeners.delete(handleStorageChange);
    unsubscribeStorage();
  };
}

const getServerSnapshot = (): SlowRequestWarningsPauseState | null => null;

export function useActiveSlowRequestWarningsPause(): SlowRequestWarningsPauseState | null {
  return useSyncExternalStore(
    subscribeSlowRequestWarningsPause,
    () => readSlowRequestWarningsPause(),
    getServerSnapshot,
  );
}
