// @effect-diagnostics globalTimers:off -- Retries and trailing debounces run at helper callback boundaries outside Effect fibers.
import type { WindowDockClient } from "./WindowDockClient.ts";

import {
  approxSameFrame,
  BROWSER_MIN_WINDOW_WIDTH,
  clipToWorkArea,
  createTrailingDebounce,
  defaultDebounceTimers,
  DOCK_REARRANGE_DEBOUNCE_MS,
  isWindowMaximizedToWorkArea,
  panelWidthToDips,
  sameFrame,
  selectOwnedWindow,
  settledExcessWidth,
  sideFrame,
  type DebounceTimers,
} from "./WindowDockGeometry.ts";
import type { ScreenRect, WindowDockCandidateWindow } from "./WindowDockProtocol.ts";

export { DOCK_REARRANGE_DEBOUNCE_MS };

export interface DockKey {
  readonly threadId: string;
  readonly tabId: string;
}

export type DockEvent =
  | { readonly type: "closed"; readonly key: DockKey }
  | {
      readonly type: "failed";
      readonly key: DockKey;
      readonly reason: "no-permission" | "no-window" | "unsupported";
    };

export interface DockWindow {
  readonly getBounds: () => ScreenRect;
  /** The part of the display the window is on that the menu bar and Dock leave free. */
  readonly getWorkArea: () => ScreenRect;
  readonly setBounds: (bounds: ScreenRect) => void;
  readonly getZoomFactor: () => number;
  readonly isVisible: () => boolean;
  readonly isMinimized: () => boolean;
  readonly isMaximized: () => boolean;
  readonly isFullScreen: () => boolean;
  readonly isFocused: () => boolean;
  /** Returns the function that removes the listeners. */
  readonly subscribe: (listener: (event: "bounds" | "focus" | "visibility") => void) => () => void;
}

interface DockDeps {
  readonly helper: WindowDockClient;
  readonly mainWindow: () => DockWindow | undefined;
  readonly emit: (event: DockEvent) => void;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly timers?: DebounceTimers;
}

interface Dock {
  readonly key: DockKey;
  readonly pid: number;
  /** Width the T3 window gave up to the docked browser, once the panel measurement arrived. */
  side: number | null;
  /** Browser's share of the combined width, kept when T3 is maximized. */
  ratio: number;
  /** The panel closed after docking, so its next measurement updates the split to the new panel width. */
  reopened: boolean;
}

interface PidState {
  readonly windowId: number;
  frame: ScreenRect | null;
  minimized: boolean;
  /** User maximized the docked browser; T3 reclaimed its width and leaves the browser maximized until unmaximized or T3 is resized/moved. */
  detachedByBrowserMaximize: boolean;
  pendingExternalFrame: ScreenRect | null;
  readonly browserDebounce: ReturnType<typeof createTrailingDebounce>;
}

const idOf = ({ threadId, tabId }: DockKey) => `${threadId}\u0000${tabId}`;
const FIND_ATTEMPTS = 15;
const FIND_DELAY_MS = 200;
const SETTLE_ATTEMPTS = 10;
const SETTLE_DELAY_MS = 100;

/**
 * The docked browser sits beside the T3 window in the width the preview panel used to take.
 * Rearrangements caused by moving, resizing, or maximizing either window wait for 1500 ms of
 * stability so drags and macOS zoom animations never lag or fight the user.
 */
export class WindowDockController {
  private readonly docks = new Map<string, Dock>();
  /** The panel can be measured before the dock command arrives, since the browser takes a moment to open. */
  private readonly earlyWidths = new Map<string, number>();
  private readonly pids = new Map<number, PidState>();
  private unsubscribeWindow: (() => void) | undefined;
  private readonly unsubscribeClosed: () => void;
  private readonly unsubscribeFrameChanged: () => void;
  private readonly settling = new Set<Promise<void>>();
  private readonly timers: DebounceTimers;
  private readonly windowBoundsDebounce: ReturnType<typeof createTrailingDebounce>;
  private readonly raiseTimers = new Set<unknown>();
  private applyingWindowBounds = false;

  private readonly deps: DockDeps;

  constructor(deps: DockDeps) {
    this.deps = deps;
    this.timers = deps.timers ?? defaultDebounceTimers;
    this.windowBoundsDebounce = createTrailingDebounce(DOCK_REARRANGE_DEBOUNCE_MS, this.timers);
    this.unsubscribeClosed = deps.helper.onClosed(({ pid, windowId }) =>
      this.windowClosed(pid, windowId),
    );
    this.unsubscribeFrameChanged = deps.helper.onFrameChanged(({ pid, windowId, frame }) =>
      this.browserFrameChanged(pid, windowId, frame),
    );
  }

  async dock(key: DockKey, pid: number): Promise<void> {
    if (this.docks.get(idOf(key))?.pid === pid) return;
    const { helper } = this.deps;
    const trusted = await helper.checkTrusted(false);
    if (!trusted) {
      return this.deps.emit({ type: "failed", key, reason: "no-permission" });
    }
    const sleep = this.deps.sleep ?? ((ms) => new Promise<void>((done) => setTimeout(done, ms)));
    const existingPidState = this.pids.get(pid);
    let selected: WindowDockCandidateWindow | null = null;
    for (let attempt = 0; attempt < FIND_ATTEMPTS && !selected; attempt++) {
      if (attempt > 0) await sleep(FIND_DELAY_MS);
      const reply = await helper.find(pid);
      selected = selectOwnedWindow(reply.windows, pid, existingPidState?.windowId ?? null);
    }
    if (!selected) return this.deps.emit({ type: "failed", key, reason: "no-window" });
    const id = idOf(key);
    const existing = [...this.docks.values()].find((dock) => dock.pid === pid);
    const dock: Dock = {
      key,
      pid,
      side: existing?.side ?? null,
      ratio: existing?.ratio ?? 0,
      reopened: false,
    };
    this.docks.set(id, dock);
    const early = this.earlyWidths.get(id);
    this.earlyWidths.delete(id);
    if (!this.pids.has(pid)) {
      this.pids.set(pid, {
        windowId: selected.windowId,
        frame: null,
        minimized: false,
        detachedByBrowserMaximize: false,
        pendingExternalFrame: null,
        browserDebounce: createTrailingDebounce(DOCK_REARRANGE_DEBOUNCE_MS, this.timers),
      });
      helper.watch(pid, selected.windowId);
    }
    if (early !== undefined && dock.side === null) this.setSideWidth(dock, early);
    this.unsubscribeWindow ??= this.deps.mainWindow()?.subscribe((event) => {
      if (event === "focus") this.raiseAll();
      else if (event === "visibility") {
        this.windowBoundsDebounce.cancel();
        this.applyVisibilityAll();
      } else if (!this.applyingWindowBounds) {
        this.windowBoundsDebounce.schedule(() => this.rearrangeForWindowBounds());
      }
    });
    this.apply(pid);
  }

  undock(key: DockKey): void {
    const id = idOf(key);
    this.earlyWidths.delete(id);
    const dock = this.docks.get(id);
    if (!dock) return;
    this.release(id, dock);
  }

  /** Returns true once the T3 window has made room for the docked browser, so the panel can close. */
  setPanelRect(key: DockKey, panel: ScreenRect | null): boolean {
    const id = idOf(key);
    const dock = this.docks.get(id);
    if (dock?.side) {
      if (!panel) {
        dock.reopened = true;
        return true;
      }
      // Measurements of the panel that just made room arrive before it closes; only a reopened panel updates the split.
      if (dock.reopened) {
        dock.reopened = false;
        const pidState = this.pids.get(dock.pid);
        if (pidState?.detachedByBrowserMaximize) {
          pidState.detachedByBrowserMaximize = false;
          dock.side = null;
        }
        this.setSideWidth(
          dock,
          panelWidthToDips(panel.width, this.deps.mainWindow()?.getZoomFactor() ?? 1),
        );
        this.apply(dock.pid);
      }
      return true;
    }
    if (!panel) {
      this.earlyWidths.delete(id);
      return false;
    }
    const width = panelWidthToDips(panel.width, this.deps.mainWindow()?.getZoomFactor() ?? 1);
    if (!dock) {
      this.earlyWidths.set(id, width);
      return false;
    }
    this.setSideWidth(dock, width);
    this.apply(dock.pid);
    return dock.side !== null;
  }

  /** Resolves once every pending check of the browser's real size has finished. */
  async idle(): Promise<void> {
    while (this.settling.size > 0) await Promise.all(this.settling);
  }

  dispose(): void {
    this.windowBoundsDebounce.cancel();
    this.clearRaiseTimers();
    for (const [id, dock] of this.docks) this.release(id, dock);
    this.detachWindow();
    this.unsubscribeClosed();
    this.unsubscribeFrameChanged();
    this.docks.clear();
    this.pids.clear();
  }

  private setWindowBounds(window: DockWindow, bounds: ScreenRect) {
    this.applyingWindowBounds = true;
    try {
      window.setBounds(bounds);
    } finally {
      this.applyingWindowBounds = false;
    }
  }

  private setSideWidth(dock: Dock, desiredWidth: number) {
    const window = this.deps.mainWindow();
    if (!window || desiredWidth < 1) return;
    const before = window.getBounds();
    const previousSide = dock.side ?? 0;
    const delta = desiredWidth - previousSide;
    if (delta !== 0) {
      this.setWindowBounds(window, { ...before, width: before.width - delta });
    }
    // The window may refuse to shrink past its minimum width, so the browser takes what was actually freed.
    const actualDelta = before.width - window.getBounds().width;
    const nextSide =
      actualDelta !== 0
        ? Math.max(1, previousSide + actualDelta)
        : previousSide === 0
          ? desiredWidth
          : previousSide;
    dock.side = nextSide;
    dock.ratio = nextSide / (window.getBounds().width + nextSide || 1);
    for (const other of this.docks.values()) {
      if (other.pid === dock.pid) {
        other.side = dock.side;
        other.ratio = dock.ratio;
      }
    }
  }

  private release(id: string, dock: Dock) {
    this.docks.delete(id);
    const stillDockedForPid = [...this.docks.values()].some((other) => other.pid === dock.pid);
    const pidState = this.pids.get(dock.pid);
    const window = this.deps.mainWindow();
    if (
      window &&
      dock.side &&
      !pidState?.detachedByBrowserMaximize &&
      !window.isFullScreen() &&
      !stillDockedForPid
    ) {
      const bounds = window.getBounds();
      this.setWindowBounds(window, { ...bounds, width: bounds.width + dock.side });
    }
    if (!stillDockedForPid) {
      pidState?.browserDebounce.cancel();
      this.pids.delete(dock.pid);
      this.deps.helper.unwatch(dock.pid, pidState?.windowId);
    } else {
      this.apply(dock.pid);
    }
    if (this.docks.size === 0) {
      this.windowBoundsDebounce.cancel();
      this.clearRaiseTimers();
      this.detachWindow();
    }
  }

  private clearRaiseTimers() {
    for (const timer of this.raiseTimers) this.timers.clear(timer);
    this.raiseTimers.clear();
  }

  private detachWindow() {
    this.unsubscribeWindow?.();
    this.unsubscribeWindow = undefined;
  }

  private windowClosed(pid: number, windowId: number | undefined) {
    const state = this.pids.get(pid);
    if (!state) return;
    if (windowId !== undefined && windowId !== state.windowId) return;
    state.browserDebounce.cancel();
    for (const [id, dock] of this.docks) {
      if (dock.pid !== pid) continue;
      this.deps.emit({ type: "closed", key: dock.key });
      this.release(id, dock);
    }
    this.pids.delete(pid);
  }

  private browserFrameChanged(pid: number, windowId: number, frame: ScreenRect) {
    const state = this.pids.get(pid);
    if (!state || state.windowId !== windowId || state.minimized) return;
    if (state.frame && approxSameFrame(frame, state.frame)) return;
    state.pendingExternalFrame = frame;
    state.browserDebounce.schedule(() => this.rearrangeForBrowserFrame(pid));
  }

  private rearrangeForBrowserFrame(pid: number) {
    const state = this.pids.get(pid);
    const window = this.deps.mainWindow();
    if (!state || !window) return;
    const latest = state.pendingExternalFrame;
    state.pendingExternalFrame = null;
    if (!latest || state.minimized) return;
    if (state.frame && approxSameFrame(latest, state.frame)) return;
    const dock = [...this.docks.values()].find(
      (candidate) => candidate.pid === pid && candidate.side,
    );
    if (!dock?.side) return;
    if (isWindowMaximizedToWorkArea(latest, window.getWorkArea())) {
      // Respect the user maximizing the browser: leave its frame maximized and restore T3's width.
      if (!state.detachedByBrowserMaximize) {
        state.detachedByBrowserMaximize = true;
        if (!window.isFullScreen() && !window.isMaximized()) {
          const bounds = window.getBounds();
          this.setWindowBounds(window, { ...bounds, width: bounds.width + dock.side });
        }
      }
      state.frame = latest;
      return;
    }
    if (state.detachedByBrowserMaximize) {
      state.detachedByBrowserMaximize = false;
      const savedSide = dock.side;
      dock.side = null;
      this.setSideWidth(dock, savedSide);
    }
    state.frame = null;
    this.apply(pid);
  }

  /** A maximized window has no room beside it, so the split is redrawn inside the same width. */
  private fitMaximized() {
    const window = this.deps.mainWindow();
    if (!window?.isMaximized() || window.isFullScreen()) return;
    const fitted = new Set<number>();
    for (const dock of this.docks.values()) {
      if (fitted.has(dock.pid)) continue;
      if (!dock.side) continue;
      fitted.add(dock.pid);
      const bounds = window.getBounds();
      const browserWidth = Math.round(bounds.width * dock.ratio);
      this.setWindowBounds(window, { ...bounds, width: bounds.width - browserWidth });
      dock.side = browserWidth;
      for (const other of this.docks.values())
        if (other.pid === dock.pid) other.side = browserWidth;
    }
  }

  private rearrangeForWindowBounds() {
    const window = this.deps.mainWindow();
    if (!window) return;
    for (const [pid, state] of this.pids) {
      if (!state.detachedByBrowserMaximize) continue;
      state.detachedByBrowserMaximize = false;
      state.browserDebounce.cancel();
      state.pendingExternalFrame = null;
      const dock = [...this.docks.values()].find(
        (candidate) => candidate.pid === pid && candidate.side,
      );
      if (dock?.side && !window.isMaximized() && !window.isFullScreen()) {
        const savedSide = dock.side;
        dock.side = null;
        this.setSideWidth(dock, savedSide);
      }
      state.frame = null;
    }
    this.fitMaximized();
    for (const pid of this.pids.keys()) this.apply(pid);
  }

  private applyVisibilityAll() {
    for (const pid of this.pids.keys()) this.apply(pid);
  }

  private raiseAll() {
    const raise = () => {
      for (const [pid, state] of this.pids) {
        if (!state.minimized && !state.detachedByBrowserMaximize) {
          this.deps.helper.raise(pid, state.windowId);
        }
      }
    };
    raise();
    // macOS reorders T3's windows after the focus event, so the first raise can land underneath.
    for (const delay of [60, 250]) {
      const handle = this.timers.set(() => {
        this.raiseTimers.delete(handle);
        raise();
      }, delay);
      this.raiseTimers.add(handle);
    }
  }

  private apply(pid: number) {
    const state = this.pids.get(pid);
    if (!state) return;
    const { helper } = this.deps;
    const window = this.deps.mainWindow();
    const side = [...this.docks.values()].find((dock) => dock.pid === pid && dock.side)?.side;
    const visible = Boolean(
      side && window && window.isVisible() && !window.isMinimized() && !window.isFullScreen(),
    );
    if (!visible || !side || !window) {
      state.browserDebounce.cancel();
      state.pendingExternalFrame = null;
      if (!state.minimized) helper.setMinimized(pid, state.windowId, true);
      state.minimized = true;
      state.frame = null;
      return;
    }
    if (state.detachedByBrowserMaximize) {
      if (state.minimized) {
        helper.setMinimized(pid, state.windowId, false);
        state.minimized = false;
      }
      return;
    }
    const frame = clipToWorkArea(sideFrame(window.getBounds(), side), window.getWorkArea());
    const reveal = state.minimized || state.frame === null;
    if (state.minimized) helper.setMinimized(pid, state.windowId, false);
    state.minimized = false;
    if (!sameFrame(state.frame, frame)) {
      helper.setFrame(pid, state.windowId, frame);
      if (frame.width < BROWSER_MIN_WINDOW_WIDTH) {
        const check = this.settle(pid, state.windowId, frame).finally(() =>
          this.settling.delete(check),
        );
        this.settling.add(check);
      }
    }
    state.frame = frame;
    if (reveal) helper.raise(pid, state.windowId);
  }

  /**
   * When the requested slot is narrower than a browser's minimum window width (~500 DIPs), the
   * T3 window gives up only the difference up to `BROWSER_MIN_WINDOW_WIDTH` so the two sit edge
   * to edge without ever inflating to an unresized default window width.
   */
  private async settle(pid: number, windowId: number, requested: ScreenRect) {
    const sleep = this.deps.sleep ?? ((ms) => new Promise<void>((done) => setTimeout(done, ms)));
    await sleep(SETTLE_DELAY_MS);
    let owned = selectOwnedWindow((await this.deps.helper.find(pid)).windows, pid, windowId);
    for (let attempt = 0; attempt < SETTLE_ATTEMPTS; attempt++) {
      await sleep(SETTLE_DELAY_MS);
      const next = selectOwnedWindow((await this.deps.helper.find(pid)).windows, pid, windowId);
      const stable =
        owned !== null &&
        next !== null &&
        next.frame.width === owned.frame.width &&
        next.frame.width <= BROWSER_MIN_WINDOW_WIDTH;
      owned = next;
      if (stable) break;
    }
    const state = this.pids.get(pid);
    const window = this.deps.mainWindow();
    if (!owned || !state || state.windowId !== windowId || !window) return;
    const excess = settledExcessWidth(requested.width, owned.frame.width);
    if (excess < 1) return;
    const before = window.getBounds();
    this.setWindowBounds(window, { ...before, width: before.width - excess });
    const freed = before.width - window.getBounds().width;
    if (freed < 1) return;
    for (const dock of this.docks.values()) {
      if (dock.pid === pid && dock.side) {
        dock.side += freed;
        dock.ratio = dock.side / (window.getBounds().width + dock.side);
      }
    }
    this.apply(pid);
  }
}
