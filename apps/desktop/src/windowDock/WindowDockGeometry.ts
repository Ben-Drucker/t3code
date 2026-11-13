// @effect-diagnostics globalTimers:off -- Debounce timers run at native window event boundaries outside Effect fibers.
import type { ScreenRect, WindowDockCandidateWindow } from "./WindowDockProtocol.ts";

/**
 * Normal Chrome and Firefox (`--window-min-width: 500px`) windows on macOS enforce at most a
 * 500 DIP minimum width. Capping settle adjustments here prevents an unresized default window
 * (~1280 DIPs) from being mistaken for the browser's minimum width.
 */
export const BROWSER_MIN_WINDOW_WIDTH = 500;

/** Trailing stability window before rearranging docked windows after user resize/move/maximize. */
export const DOCK_REARRANGE_DEBOUNCE_MS = 1_500;

/**
 * Electron reports window bounds in DIPs, which on macOS are the points the Accessibility API
 * uses, both with a top-left origin. The renderer's panel rect is in CSS px, which webContents
 * zoom scales to DIPs. Display scale never enters.
 */
export const panelWidthToDips = (panelWidth: number, zoomFactor: number) => {
  const zoom = Number.isFinite(zoomFactor) && zoomFactor > 0 ? zoomFactor : 1;
  return Math.round(panelWidth * zoom);
};

/** The docked browser fills the strip the T3 window gave up, level with it and as tall. */
export const sideFrame = (window: ScreenRect, width: number): ScreenRect => ({
  x: window.x + window.width,
  y: window.y,
  width,
  height: window.height,
});

/** The Dock can sit over the strip beside the window, so the browser stops at the usable edge. */
export const clipToWorkArea = (frame: ScreenRect, area: ScreenRect): ScreenRect => ({
  ...frame,
  width: Math.max(1, Math.min(frame.width, area.x + area.width - frame.x)),
});

export const sameFrame = (a: ScreenRect | null, b: ScreenRect | null) =>
  a === b ||
  (a !== null &&
    b !== null &&
    a.x === b.x &&
    a.y === b.y &&
    a.width === b.width &&
    a.height === b.height);

export const approxSameFrame = (
  a: ScreenRect | null,
  b: ScreenRect | null,
  tolerance = 2,
): boolean =>
  a === b ||
  (a !== null &&
    b !== null &&
    Math.abs(a.x - b.x) <= tolerance &&
    Math.abs(a.y - b.y) <= tolerance &&
    Math.abs(a.width - b.width) <= tolerance &&
    Math.abs(a.height - b.height) <= tolerance);

export const settledExcessWidth = (
  requestedWidth: number,
  measuredWidth: number,
  maxMinWidth = BROWSER_MIN_WINDOW_WIDTH,
): number => {
  const effectiveMinWidth = Math.min(Math.round(measuredWidth), maxMinWidth);
  return Math.max(0, effectiveMinWidth - Math.round(requestedWidth));
};

export const isWindowMaximizedToWorkArea = (
  frame: ScreenRect,
  workArea: ScreenRect,
  tolerance = 8,
): boolean =>
  frame.width >= workArea.width - tolerance &&
  frame.height >= workArea.height - tolerance &&
  Math.abs(frame.x - workArea.x) <= tolerance &&
  Math.abs(frame.y - workArea.y) <= tolerance;

/**
 * Picks only T3's owned standard window for `ownedPid`. Once bound to `boundWindowId`, other
 * windows of the same process or other processes are ignored; if the bound window is gone, returns
 * `null` so the caller does nothing.
 */
export const selectOwnedWindow = (
  candidates: ReadonlyArray<WindowDockCandidateWindow>,
  ownedPid: number,
  boundWindowId: number | null,
): WindowDockCandidateWindow | null => {
  const owned = candidates.filter((candidate) => candidate.pid === ownedPid && candidate.standard);
  if (boundWindowId !== null) {
    return owned.find((candidate) => candidate.windowId === boundWindowId) ?? null;
  }
  return owned.find((candidate) => !candidate.minimized) ?? owned[0] ?? null;
};

export interface DebounceTimers {
  readonly set: (callback: () => void, delayMs: number) => unknown;
  readonly clear: (handle: unknown) => void;
}

export const defaultDebounceTimers: DebounceTimers = {
  set: (callback, delayMs) => setTimeout(callback, delayMs),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export const createTrailingDebounce = (
  delayMs: number,
  timers: DebounceTimers = defaultDebounceTimers,
) => {
  let pending: unknown;
  return {
    schedule: (action: () => void) => {
      if (pending !== undefined) timers.clear(pending);
      pending = timers.set(() => {
        pending = undefined;
        action();
      }, delayMs);
    },
    cancel: () => {
      if (pending === undefined) return;
      timers.clear(pending);
      pending = undefined;
    },
    isPending: () => pending !== undefined,
  };
};
