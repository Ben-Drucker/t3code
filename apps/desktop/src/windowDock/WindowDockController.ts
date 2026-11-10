// @effect-diagnostics globalTimers:off -- Retries run at helper callback boundaries outside Effect fibers.
import type { WindowDockClient } from "./WindowDockClient.ts";

import { panelWidthToDips, sameFrame, sideFrame } from "./WindowDockGeometry.ts";
import type { ScreenRect } from "./WindowDockProtocol.ts";

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
}

interface Dock {
  readonly key: DockKey;
  readonly pid: number;
  /** Width the T3 window gave up to Chrome, once the first panel measurement arrived. */
  side: number | null;
  /** Chrome's share of the combined width, kept when the window is maximized. */
  ratio: number;
}

interface PidState {
  frame: ScreenRect | null;
  minimized: boolean;
}

const idOf = ({ threadId, tabId }: DockKey) => `${threadId}\u0000${tabId}`;
const FIND_ATTEMPTS = 15;
const FIND_DELAY_MS = 200;

/**
 * Chrome sits beside the T3 window, in the width the preview panel used to take. The panel's
 * first measurement sets that width; after that the renderer closes the panel and the window
 * itself is the layout.
 */
export class WindowDockController {
  private readonly docks = new Map<string, Dock>();
  /** The panel can be measured before the dock command arrives, since Chrome takes a moment to open. */
  private readonly earlyWidths = new Map<string, number>();
  private readonly pids = new Map<number, PidState>();
  private unsubscribeWindow: (() => void) | undefined;
  private readonly unsubscribeClosed: () => void;

  private readonly deps: DockDeps;

  constructor(deps: DockDeps) {
    this.deps = deps;
    this.unsubscribeClosed = deps.helper.onClosed((pid) => this.windowClosed(pid));
  }

  async dock(key: DockKey, pid: number): Promise<void> {
    if (this.docks.get(idOf(key))?.pid === pid) return;
    const { helper } = this.deps;
    const trusted = await helper.checkTrusted(false);
    if (!trusted) {
      return this.deps.emit({ type: "failed", key, reason: "no-permission" });
    }
    const sleep = this.deps.sleep ?? ((ms) => new Promise<void>((done) => setTimeout(done, ms)));
    let found = false;
    for (let attempt = 0; attempt < FIND_ATTEMPTS && !found; attempt++) {
      if (attempt > 0) await sleep(FIND_DELAY_MS);
      found = (await helper.find(pid)).found;
    }
    if (!found) return this.deps.emit({ type: "failed", key, reason: "no-window" });
    const id = idOf(key);
    const existing = [...this.docks.values()].find((dock) => dock.pid === pid);
    const dock: Dock = { key, pid, side: existing?.side ?? null, ratio: existing?.ratio ?? 0 };
    this.docks.set(id, dock);
    const early = this.earlyWidths.get(id);
    this.earlyWidths.delete(id);
    if (early !== undefined && dock.side === null) this.enterSide(dock, early);
    if (!this.pids.has(pid)) {
      this.pids.set(pid, { frame: null, minimized: false });
      helper.watch(pid);
    }
    this.unsubscribeWindow ??= this.deps.mainWindow()?.subscribe((event) => {
      if (event === "focus") this.raiseAll();
      else this.applyAll();
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

  /** Returns true once the T3 window has made room for Chrome, so the panel can close. */
  setPanelRect(key: DockKey, panel: ScreenRect | null): boolean {
    const id = idOf(key);
    const dock = this.docks.get(id);
    if (dock?.side) return true;
    if (!panel) {
      this.earlyWidths.delete(id);
      return false;
    }
    const width = panelWidthToDips(panel.width, this.deps.mainWindow()?.getZoomFactor() ?? 1);
    if (!dock) {
      this.earlyWidths.set(id, width);
      return false;
    }
    this.enterSide(dock, width);
    this.apply(dock.pid);
    return dock.side !== null;
  }

  dispose(): void {
    for (const [id, dock] of this.docks) this.release(id, dock);
    this.detachWindow();
    this.unsubscribeClosed();
    this.docks.clear();
    this.pids.clear();
  }

  private enterSide(dock: Dock, width: number) {
    const window = this.deps.mainWindow();
    if (!window || width < 1) return;
    const before = window.getBounds();
    window.setBounds({ ...before, width: before.width - width });
    // The window may refuse to shrink all the way, so Chrome takes what was actually freed.
    const freed = before.width - window.getBounds().width;
    dock.side = freed >= 1 ? freed : width;
    dock.ratio = dock.side / (before.width || 1);
    for (const other of this.docks.values())
      if (other.pid === dock.pid) {
        other.side = dock.side;
        other.ratio = dock.ratio;
      }
  }

  private release(id: string, dock: Dock) {
    this.docks.delete(id);
    const window = this.deps.mainWindow();
    if (
      window &&
      dock.side &&
      !window.isFullScreen() &&
      ![...this.docks.values()].some((other) => other.pid === dock.pid)
    ) {
      const bounds = window.getBounds();
      window.setBounds({ ...bounds, width: bounds.width + dock.side });
    }
    if (![...this.docks.values()].some((other) => other.pid === dock.pid)) {
      this.pids.delete(dock.pid);
      this.deps.helper.unwatch(dock.pid);
    } else this.apply(dock.pid);
    if (this.docks.size === 0) this.detachWindow();
  }

  private detachWindow() {
    this.unsubscribeWindow?.();
    this.unsubscribeWindow = undefined;
  }

  private windowClosed(pid: number) {
    for (const [id, dock] of this.docks) {
      if (dock.pid !== pid) continue;
      this.deps.emit({ type: "closed", key: dock.key });
      this.release(id, dock);
    }
    this.pids.delete(pid);
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
      const chrome = Math.round(bounds.width * dock.ratio);
      window.setBounds({ ...bounds, width: bounds.width - chrome });
      dock.side = chrome;
      for (const other of this.docks.values()) if (other.pid === dock.pid) other.side = chrome;
    }
  }

  private applyAll() {
    this.fitMaximized();
    for (const pid of this.pids.keys()) this.apply(pid);
  }

  private raiseAll() {
    const raise = () => {
      for (const pid of this.pids.keys()) {
        if (this.pids.get(pid)?.minimized === false) this.deps.helper.raise(pid);
      }
    };
    raise();
    // macOS reorders T3's windows after the focus event, so the first raise can land underneath.
    setTimeout(raise, 60);
    setTimeout(raise, 250);
  }

  private apply(pid: number) {
    const state = this.pids.get(pid);
    if (!state) return;
    const { helper } = this.deps;
    const window = this.deps.mainWindow();
    const side = [...this.docks.values()].find((dock) => dock.pid === pid && dock.side)?.side;
    const frame =
      side && window && window.isVisible() && !window.isMinimized() && !window.isFullScreen()
        ? sideFrame(window.getBounds(), side)
        : null;
    if (!frame) {
      if (!state.minimized) helper.setMinimized(pid, true);
      state.minimized = true;
      state.frame = null;
      return;
    }
    const reveal = state.minimized || state.frame === null;
    if (state.minimized) helper.setMinimized(pid, false);
    state.minimized = false;
    if (!sameFrame(state.frame, frame)) helper.setFrame(pid, frame);
    state.frame = frame;
    if (reveal) helper.raise(pid);
  }
}
