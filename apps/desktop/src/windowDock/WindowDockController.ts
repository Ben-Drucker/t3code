// @effect-diagnostics globalTimers:off -- Retries run at helper callback boundaries outside Effect fibers.
import type { WindowDockClient } from "./WindowDockClient.ts";
import { panelToScreenFrame, sameFrame } from "./WindowDockGeometry.ts";
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
  readonly getContentBounds: () => ScreenRect;
  readonly getZoomFactor: () => number;
  readonly isVisible: () => boolean;
  readonly isMinimized: () => boolean;
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
  panel: ScreenRect | null;
  panelSerial: number;
}

interface PidState {
  frame: ScreenRect | null;
  minimized: boolean;
}

const idOf = ({ threadId, tabId }: DockKey) => `${threadId}\u0000${tabId}`;
const FIND_ATTEMPTS = 15;
const FIND_DELAY_MS = 200;

export class WindowDockController {
  private readonly docks = new Map<string, Dock>();
  /** Reports can precede the dock command, since Chrome takes a moment to open. */
  private readonly earlyPanels = new Map<string, ScreenRect | null>();
  private readonly pids = new Map<number, PidState>();
  private serial = 0;
  private unsubscribeWindow: (() => void) | undefined;
  private readonly unsubscribeClosed: () => void;

  private readonly deps: DockDeps;

  constructor(deps: DockDeps) {
    this.deps = deps;
    this.unsubscribeClosed = deps.helper.onClosed((pid) => this.windowClosed(pid));
  }

  async dock(key: DockKey, pid: number): Promise<void> {
    const { helper } = this.deps;
    if (!(await helper.checkTrusted(false))) {
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
    const early = this.earlyPanels.get(id) ?? null;
    this.earlyPanels.delete(id);
    this.docks.set(id, { key, pid, panel: early, panelSerial: early ? ++this.serial : 0 });
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
    this.earlyPanels.delete(id);
    const dock = this.docks.get(id);
    if (!dock) return;
    this.docks.delete(id);
    if (![...this.docks.values()].some((other) => other.pid === dock.pid)) {
      this.pids.delete(dock.pid);
      this.deps.helper.unwatch(dock.pid);
    } else this.apply(dock.pid);
    if (this.docks.size === 0) this.detachWindow();
  }

  setPanelRect(key: DockKey, panel: ScreenRect | null): void {
    const id = idOf(key);
    const dock = this.docks.get(id);
    if (!dock) {
      this.earlyPanels.set(id, panel);
      return;
    }
    dock.panel = panel;
    if (panel) dock.panelSerial = ++this.serial;
    this.apply(dock.pid);
  }

  dispose(): void {
    this.detachWindow();
    this.unsubscribeClosed();
    this.docks.clear();
    this.pids.clear();
  }

  private detachWindow() {
    this.unsubscribeWindow?.();
    this.unsubscribeWindow = undefined;
  }

  private windowClosed(pid: number) {
    for (const [id, dock] of this.docks) {
      if (dock.pid !== pid) continue;
      this.docks.delete(id);
      this.deps.emit({ type: "closed", key: dock.key });
    }
    this.pids.delete(pid);
    if (this.docks.size === 0) this.detachWindow();
  }

  private applyAll() {
    for (const pid of this.pids.keys()) this.apply(pid);
  }

  private raiseAll() {
    for (const pid of this.pids.keys()) {
      if (this.pids.get(pid)?.minimized === false) this.deps.helper.raise(pid);
    }
  }

  private apply(pid: number) {
    const state = this.pids.get(pid);
    if (!state) return;
    const { helper } = this.deps;
    const window = this.deps.mainWindow();
    const panel = [...this.docks.values()]
      .filter((dock) => dock.pid === pid && dock.panel !== null)
      .sort((a, b) => b.panelSerial - a.panelSerial)[0]?.panel;
    const frame =
      panel && window && window.isVisible() && !window.isMinimized() && !window.isFullScreen()
        ? panelToScreenFrame({
            panel,
            contentBounds: window.getContentBounds(),
            zoomFactor: window.getZoomFactor(),
          })
        : null;
    if (!frame) {
      if (!state.minimized) helper.setMinimized(pid, true);
      state.minimized = true;
      state.frame = null;
      return;
    }
    const reveal = state.minimized;
    if (reveal) helper.setMinimized(pid, false);
    state.minimized = false;
    if (!sameFrame(state.frame, frame)) helper.setFrame(pid, frame);
    state.frame = frame;
    if (reveal) helper.raise(pid);
  }
}
