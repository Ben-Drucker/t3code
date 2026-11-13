import { assert, it, vi } from "@effect/vitest";

import type {
  WindowDockClient,
  WindowDockClosedEvent,
  WindowDockFrameChangedEvent,
} from "./WindowDockClient.ts";
import {
  DOCK_REARRANGE_DEBOUNCE_MS,
  WindowDockController,
  type DockEvent,
  type DockWindow,
} from "./WindowDockController.ts";
import {
  BROWSER_MIN_WINDOW_WIDTH,
  clipToWorkArea,
  createTrailingDebounce,
  panelWidthToDips,
  selectOwnedWindow,
  settledExcessWidth,
  sideFrame,
} from "./WindowDockGeometry.ts";
import type { ScreenRect, WindowDockCandidateWindow } from "./WindowDockProtocol.ts";

function setup(
  options: {
    trusted?: boolean;
    findsAfter?: number;
    browserWidth?: number;
    minWidth?: number;
    windowsForPid?: (pid: number, attempt: number) => ReadonlyArray<WindowDockCandidateWindow>;
  } = {},
) {
  const calls: unknown[][] = [];
  let finds = 0;
  let closed: ((event: WindowDockClosedEvent) => void) | undefined;
  let frameChanged: ((event: WindowDockFrameChangedEvent) => void) | undefined;
  const client = {
    alive: () => true,
    checkTrusted: async () => options.trusted ?? true,
    find: async (pid: number) => {
      finds++;
      if (finds <= (options.findsAfter ?? 0)) {
        return { found: false as const, untrusted: false, windows: [] as const };
      }
      const windows = options.windowsForPid?.(pid, finds) ?? [
        {
          windowId: 101,
          pid,
          standard: true,
          minimized: false,
          frame: { x: 0, y: 0, width: options.browserWidth ?? 1, height: 1 },
        },
      ];
      return windows.length > 0
        ? { found: true as const, windows, contentTop: undefined }
        : { found: false as const, untrusted: false, windows: [] as const };
    },
    watch: (pid: number, windowId: number) => calls.push(["watch", pid, windowId]),
    unwatch: (pid: number, windowId?: number) => calls.push(["unwatch", pid, windowId]),
    setFrame: (pid: number, windowId: number, frame: unknown) =>
      calls.push(["setFrame", pid, windowId, frame]),
    raise: (pid: number, windowId: number) => calls.push(["raise", pid, windowId]),
    setMinimized: (pid: number, windowId: number, minimized: boolean) =>
      calls.push(["minimize", pid, windowId, minimized]),
    onClosed: (listener: (event: WindowDockClosedEvent) => void) => {
      closed = listener;
      return () => undefined;
    },
    onFrameChanged: (listener: (event: WindowDockFrameChangedEvent) => void) => {
      frameChanged = listener;
      return () => undefined;
    },
    close: () => undefined,
  } satisfies WindowDockClient;
  const events: DockEvent[] = [];
  let listener: Parameters<DockWindow["subscribe"]>[0] | undefined;
  const state = {
    visible: true,
    minimized: false,
    fullScreen: false,
    maximized: false,
    bounds: { x: 100, y: 50, width: 800, height: 600 },
    workArea: { x: 0, y: 0, width: 1600, height: 900 },
  };
  const window: DockWindow = {
    getBounds: () => state.bounds,
    getWorkArea: () => state.workArea,
    setBounds: (bounds) => {
      state.bounds = { ...bounds, width: Math.max(bounds.width, options.minWidth ?? 0) };
    },
    getZoomFactor: () => 1,
    isVisible: () => state.visible,
    isMinimized: () => state.minimized,
    isMaximized: () => state.maximized,
    isFullScreen: () => state.fullScreen,
    isFocused: () => true,
    subscribe: (next) => {
      listener = next;
      return () => undefined;
    },
  };
  const controller = new WindowDockController({
    helper: client,
    mainWindow: () => window,
    emit: (event) => events.push(event),
    sleep: async () => undefined,
  });
  return {
    controller,
    calls,
    events,
    state,
    emitWindow: (event: "bounds" | "focus" | "visibility") => listener?.(event),
    emitBrowserFrame: (pid: number, windowId: number, frame: ScreenRect) =>
      frameChanged?.({ pid, windowId, frame }),
    closeBrowser: (pid: number, windowId = 101) => closed?.({ pid, windowId }),
  };
}

const key = { threadId: "t", tabId: "a" };
const panel = { x: 400, y: 40, width: 300, height: 500 };

it("scales the panel width by zoom, clips to the work area, and caps min-width excess", () => {
  assert.strictEqual(panelWidthToDips(100.4, 1.5), 151);
  assert.deepStrictEqual(sideFrame({ x: 100, y: 50, width: 500, height: 600 }, 300), {
    x: 600,
    y: 50,
    width: 300,
    height: 600,
  });
  assert.deepStrictEqual(
    clipToWorkArea(
      { x: 600, y: 50, width: 500, height: 600 },
      { x: 0, y: 0, width: 1000, height: 900 },
    ),
    { x: 600, y: 50, width: 400, height: 600 },
  );
  assert.strictEqual(settledExcessWidth(540, 1280), 0);
  assert.strictEqual(settledExcessWidth(360, 1280), BROWSER_MIN_WINDOW_WIDTH - 360);
  assert.strictEqual(settledExcessWidth(300, 400), 100);
});

it("shrinks the window by the panel width, debounces moves by 1500 ms, and matches reopened panel widths", async () => {
  vi.useFakeTimers();
  try {
    const t = setup({ findsAfter: 2 });
    assert.isFalse(t.controller.setPanelRect(key, panel));
    await t.controller.dock(key, 9);
    assert.deepStrictEqual(t.state.bounds, { x: 100, y: 50, width: 500, height: 600 });
    assert.deepStrictEqual(
      t.calls.filter((c) => c[0] === "setFrame"),
      [["setFrame", 9, 101, { x: 600, y: 50, width: 300, height: 600 }]],
    );

    // Burst of T3 moves coalesces; nothing rearranges before 1500 ms, and only the last rect wins.
    t.state.bounds = { ...t.state.bounds, x: 105 };
    t.emitWindow("bounds");
    vi.advanceTimersByTime(DOCK_REARRANGE_DEBOUNCE_MS - 100);
    t.state.bounds = { ...t.state.bounds, x: 110 };
    t.emitWindow("bounds");
    vi.advanceTimersByTime(DOCK_REARRANGE_DEBOUNCE_MS - 1);
    assert.strictEqual(t.calls.filter((c) => c[0] === "setFrame").length, 1);

    vi.advanceTimersByTime(1);
    assert.strictEqual(t.calls.filter((c) => c[0] === "setFrame").length, 2);
    assert.deepStrictEqual(t.calls.filter((c) => c[0] === "setFrame").at(-1), [
      "setFrame",
      9,
      101,
      { x: 610, y: 50, width: 300, height: 600 },
    ]);

    // Reopening at the same width keeps the split instead of doubling it; narrower updates to match.
    assert.isTrue(t.controller.setPanelRect(key, null));
    assert.isTrue(t.controller.setPanelRect(key, panel));
    assert.strictEqual(t.state.bounds.width, 500);
    assert.deepStrictEqual(t.calls.filter((c) => c[0] === "setFrame").at(-1), [
      "setFrame",
      9,
      101,
      { x: 610, y: 50, width: 300, height: 600 },
    ]);
    assert.isTrue(t.controller.setPanelRect(key, null));
    assert.isTrue(t.controller.setPanelRect(key, { ...panel, width: 200 }));
    assert.strictEqual(t.state.bounds.width, 600);
    assert.deepStrictEqual(t.calls.filter((c) => c[0] === "setFrame").at(-1), [
      "setFrame",
      9,
      101,
      { x: 710, y: 50, width: 200, height: 600 },
    ]);
    t.controller.dispose();
  } finally {
    vi.useRealTimers();
  }
});

it("matches the preview panel width instead of inflating to an unresized 2/3-screen Firefox window", async () => {
  const t = setup({ browserWidth: 1280 });
  t.state.bounds = { x: 100, y: 50, width: 1400, height: 900 };
  const firefoxPanel = { x: 960, y: 50, width: 540, height: 900 };
  await t.controller.dock(key, 9);
  t.controller.setPanelRect(key, firefoxPanel);
  await t.controller.idle();
  assert.strictEqual(t.state.bounds.width, 860);
  assert.deepStrictEqual(t.calls.filter((c) => c[0] === "setFrame").at(-1), [
    "setFrame",
    9,
    101,
    { x: 960, y: 50, width: 540, height: 900 },
  ]);
});

it("clamps a narrow panel only up to the browser's real minimum width, never wider", async () => {
  const t = setup({ browserWidth: 1280 });
  t.state.bounds = { x: 100, y: 50, width: 1400, height: 900 };
  const narrowPanel = { x: 1140, y: 50, width: 360, height: 900 };
  await t.controller.dock(key, 9);
  t.controller.setPanelRect(key, narrowPanel);
  await t.controller.idle();
  assert.strictEqual(t.state.bounds.width, 900);
  assert.deepStrictEqual(t.calls.filter((c) => c[0] === "setFrame").at(-1), [
    "setFrame",
    9,
    101,
    { x: 1000, y: 50, width: 500, height: 900 },
  ]);
});

it("shrinks the window to sit edge to edge with a browser that is wider than its slot", async () => {
  const t = setup({ browserWidth: 400 });
  await t.controller.dock(key, 9);
  t.controller.setPanelRect(key, panel);
  await t.controller.idle();
  assert.strictEqual(t.state.bounds.width, 400);
  assert.deepStrictEqual(t.calls.filter((c) => c[0] === "setFrame").at(-1), [
    "setFrame",
    9,
    101,
    { x: 500, y: 50, width: 400, height: 600 },
  ]);
});

it("does not grow the browser each time the panel reopens while the window cannot shrink", async () => {
  const t = setup({ minWidth: 800 });
  await t.controller.dock(key, 9);
  for (let reopen = 0; reopen < 3; reopen++) {
    t.controller.setPanelRect(key, panel);
    t.controller.setPanelRect(key, null);
  }
  t.controller.setPanelRect(key, panel);
  const frame = t.calls.filter((c) => c[0] === "setFrame").at(-1)?.[3] as { width: number };
  assert.strictEqual(frame.width, 300);
});

it("restores the window width when the docked browser closes and cancels pending rearranges", async () => {
  vi.useFakeTimers();
  try {
    const t = setup();
    await t.controller.dock(key, 9);
    assert.isTrue(t.controller.setPanelRect(key, panel));
    assert.strictEqual(t.state.bounds.width, 500);
    t.state.bounds = { ...t.state.bounds, x: 140 };
    t.emitWindow("bounds");
    t.closeBrowser(9, 101);
    assert.strictEqual(t.state.bounds.width, 800);
    assert.deepStrictEqual(t.events, [{ type: "closed", key }]);
    const setFrameCount = t.calls.filter((c) => c[0] === "setFrame").length;
    vi.advanceTimersByTime(DOCK_REARRANGE_DEBOUNCE_MS * 2);
    assert.strictEqual(t.calls.filter((c) => c[0] === "setFrame").length, setFrameCount);
  } finally {
    vi.useRealTimers();
  }
});

it("shares a Firefox process between tabs and restores T3 only after its last tab closes", async () => {
  const t = setup();
  await t.controller.dock(key, 42);
  t.controller.setPanelRect(key, panel);
  const second = { ...key, tabId: "firefox-second" };
  t.controller.setPanelRect(second, panel);
  await t.controller.dock(second, 42);
  assert.strictEqual(t.state.bounds.width, 500);
  t.controller.undock(key);
  assert.strictEqual(t.state.bounds.width, 500);
  t.controller.undock(second);
  assert.strictEqual(t.state.bounds.width, 800);
  assert.strictEqual(t.calls.filter((call) => call[0] === "watch").length, 1);
  assert.strictEqual(t.calls.filter((call) => call[0] === "unwatch").length, 1);
});

it("debounces T3 maximize/unmaximize by 1500 ms and keeps the split once stable", async () => {
  vi.useFakeTimers();
  try {
    const t = setup();
    await t.controller.dock(key, 9);
    t.controller.setPanelRect(key, panel);
    t.calls.length = 0;

    t.state.bounds = { x: 0, y: 0, width: 1600, height: 900 };
    t.state.maximized = true;
    t.emitWindow("bounds");
    vi.advanceTimersByTime(DOCK_REARRANGE_DEBOUNCE_MS - 1);
    assert.strictEqual(t.state.bounds.width, 1600);
    assert.deepStrictEqual(t.calls, []);

    vi.advanceTimersByTime(1);
    assert.deepStrictEqual(t.state.bounds, { x: 0, y: 0, width: 1000, height: 900 });
    assert.deepStrictEqual(t.calls.filter((c) => c[0] === "setFrame").at(-1), [
      "setFrame",
      9,
      101,
      { x: 1000, y: 0, width: 600, height: 900 },
    ]);
    t.controller.dispose();
  } finally {
    vi.useRealTimers();
  }
});

it("debounces browser maximize and user resize by 1500 ms, respecting maximize and re-docking unmaximize", async () => {
  vi.useFakeTimers();
  try {
    const t = setup();
    await t.controller.dock(key, 9);
    t.controller.setPanelRect(key, panel);
    assert.strictEqual(t.state.bounds.width, 500);
    t.calls.length = 0;

    // User maximizes Firefox to fill the display work area: wait 1500 ms, leave Firefox maximized, restore T3 width.
    t.emitBrowserFrame(9, 101, { x: 0, y: 0, width: 1600, height: 900 });
    vi.advanceTimersByTime(DOCK_REARRANGE_DEBOUNCE_MS - 1);
    assert.strictEqual(t.state.bounds.width, 500);
    assert.deepStrictEqual(t.calls, []);

    vi.advanceTimersByTime(1);
    assert.strictEqual(t.state.bounds.width, 800);
    assert.deepStrictEqual(
      t.calls.filter((c) => c[0] === "setFrame"),
      [],
    );

    // User unmaximizes/resizes Firefox back down (burst of intermediate frames): coalesces and re-docks after 1500 ms.
    t.emitBrowserFrame(9, 101, { x: 200, y: 80, width: 900, height: 700 });
    vi.advanceTimersByTime(500);
    t.emitBrowserFrame(9, 101, { x: 250, y: 80, width: 700, height: 650 });
    vi.advanceTimersByTime(DOCK_REARRANGE_DEBOUNCE_MS - 1);
    assert.strictEqual(t.state.bounds.width, 800);
    assert.deepStrictEqual(
      t.calls.filter((c) => c[0] === "setFrame"),
      [],
    );

    vi.advanceTimersByTime(1);
    assert.strictEqual(t.state.bounds.width, 500);
    assert.deepStrictEqual(t.calls.filter((c) => c[0] === "setFrame").at(-1), [
      "setFrame",
      9,
      101,
      { x: 600, y: 50, width: 300, height: 600 },
    ]);
    t.controller.dispose();
  } finally {
    vi.useRealTimers();
  }
});

it("coalesces and cancels trailing debounce calls with injected timers", () => {
  const scheduled = new Map<number, () => void>();
  let nextHandle = 1;
  const debouncer = createTrailingDebounce(DOCK_REARRANGE_DEBOUNCE_MS, {
    set: (callback) => {
      const id = nextHandle++;
      scheduled.set(id, callback);
      return id;
    },
    clear: (handle) => {
      scheduled.delete(handle as number);
    },
  });
  const seen: string[] = [];
  debouncer.schedule(() => seen.push("first"));
  debouncer.schedule(() => seen.push("second"));
  assert.strictEqual(scheduled.size, 1);
  for (const [id, fn] of scheduled) {
    scheduled.delete(id);
    fn();
  }
  assert.deepStrictEqual(seen, ["second"]);

  debouncer.schedule(() => seen.push("cancelled"));
  assert.isTrue(debouncer.isPending());
  debouncer.cancel();
  assert.isFalse(debouncer.isPending());
  assert.strictEqual(scheduled.size, 0);
});

it("selects only the owned standard window, ignores other windows of the same app, and does nothing when none exists", async () => {
  const candidates: ReadonlyArray<WindowDockCandidateWindow> = [
    {
      windowId: 1,
      pid: 777,
      standard: true,
      minimized: false,
      frame: { x: 0, y: 0, width: 1200, height: 800 },
    },
    {
      windowId: 2,
      pid: 42,
      standard: false,
      minimized: false,
      frame: { x: 50, y: 50, width: 400, height: 200 },
    },
    {
      windowId: 3,
      pid: 42,
      standard: true,
      minimized: false,
      frame: { x: 100, y: 100, width: 900, height: 700 },
    },
    {
      windowId: 4,
      pid: 42,
      standard: true,
      minimized: false,
      frame: { x: 200, y: 100, width: 900, height: 700 },
    },
  ];
  // Initial bind for pid 42 ignores pid 777 and non-standard dialog 2, picking owned window 3.
  assert.strictEqual(selectOwnedWindow(candidates, 42, null)?.windowId, 3);
  // Once bound to window 3, other windows of pid 42 (window 4) are ignored.
  assert.strictEqual(selectOwnedWindow(candidates, 42, 3)?.windowId, 3);
  assert.isNull(
    selectOwnedWindow(
      candidates.filter((c) => c.windowId !== 3),
      42,
      3,
    ),
  );
  // No owned window for pid 999 -> null.
  assert.isNull(selectOwnedWindow(candidates, 999, null));

  // Controller targets only bound windowId 3, ignores events for windowId 4 or other pids, and emits no-window if none owned.
  vi.useFakeTimers();
  try {
    const t = setup({ windowsForPid: () => candidates });
    await t.controller.dock(key, 42);
    t.controller.setPanelRect(key, panel);
    assert.deepStrictEqual(
      t.calls.filter((c) => c[0] === "watch"),
      [["watch", 42, 3]],
    );
    assert.deepStrictEqual(
      t.calls.filter((c) => c[0] === "setFrame"),
      [["setFrame", 42, 3, { x: 600, y: 50, width: 300, height: 600 }]],
    );

    // Closing or resizing a different window of the same app (windowId 4) or another pid (777) is ignored.
    t.closeBrowser(42, 4);
    t.closeBrowser(777, 1);
    t.emitBrowserFrame(42, 4, { x: 0, y: 0, width: 1600, height: 900 });
    vi.advanceTimersByTime(DOCK_REARRANGE_DEBOUNCE_MS * 2);
    assert.deepStrictEqual(t.events, []);
    assert.strictEqual(t.state.bounds.width, 500);

    // No owned window -> emits no-window and touches nothing.
    const unowned = setup({
      windowsForPid: () => [
        {
          windowId: 1,
          pid: 777,
          standard: true,
          minimized: false,
          frame: { x: 0, y: 0, width: 1200, height: 800 },
        },
      ],
    });
    await unowned.controller.dock(key, 42);
    assert.deepStrictEqual(unowned.events, [{ type: "failed", key, reason: "no-window" }]);
    assert.deepStrictEqual(unowned.calls, []);
    t.controller.dispose();
  } finally {
    vi.useRealTimers();
  }
});

it("raises the owned window when T3 takes focus", async () => {
  vi.useFakeTimers();
  try {
    const t = setup();
    await t.controller.dock(key, 9);
    t.controller.setPanelRect(key, panel);
    t.calls.length = 0;
    t.emitWindow("focus");
    assert.deepStrictEqual(t.calls, [["raise", 9, 101]]);
    t.controller.dispose();
  } finally {
    vi.useRealTimers();
  }
});

it("hides the browser with T3 and restores its frame and focus on reveal", async () => {
  const t = setup();
  await t.controller.dock(key, 9);
  t.controller.setPanelRect(key, panel);
  for (const property of ["visible", "minimized", "fullScreen"] as const) {
    t.state[property] = property !== "visible";
    t.emitWindow("visibility");
    assert.deepStrictEqual(t.calls.at(-1), ["minimize", 9, 101, true]);
    t.calls.length = 0;
    t.state[property] = property === "visible";
    t.emitWindow("visibility");
    assert.deepStrictEqual(t.calls, [
      ["minimize", 9, 101, false],
      ["setFrame", 9, 101, { x: 600, y: 50, width: 300, height: 600 }],
      ["raise", 9, 101],
    ]);
    assert.strictEqual(t.state.bounds.width, 500);
  }
});

it("reports a missing permission or window instead of docking", async () => {
  const denied = setup({ trusted: false });
  await denied.controller.dock(key, 9);
  assert.deepStrictEqual(denied.events, [{ type: "failed", key, reason: "no-permission" }]);
  const missing = setup({ findsAfter: 100 });
  await missing.controller.dock(key, 9);
  assert.deepStrictEqual(missing.events, [{ type: "failed", key, reason: "no-window" }]);
});
