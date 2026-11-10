import { assert, it } from "@effect/vitest";

import type { WindowDockClient } from "./WindowDockClient.ts";
import { WindowDockController, type DockEvent, type DockWindow } from "./WindowDockController.ts";
import { panelWidthToDips, sideFrame } from "./WindowDockGeometry.ts";

function setup(options: { trusted?: boolean; findsAfter?: number } = {}) {
  const calls: unknown[][] = [];
  let finds = 0;
  let closed: ((pid: number) => void) | undefined;
  const client = {
    alive: () => true,
    checkTrusted: async () => options.trusted ?? true,
    find: async () => {
      finds++;
      return finds > (options.findsAfter ?? 0)
        ? {
            found: true as const,
            frame: { x: 0, y: 0, width: 1, height: 1 },
            contentTop: undefined,
          }
        : { found: false as const, untrusted: false };
    },
    watch: (pid: number) => calls.push(["watch", pid]),
    unwatch: (pid: number) => calls.push(["unwatch", pid]),
    setFrame: (pid: number, frame: unknown) => calls.push(["setFrame", pid, frame]),
    raise: (pid: number) => calls.push(["raise", pid]),
    setMinimized: (pid: number, minimized: boolean) => calls.push(["minimize", pid, minimized]),
    onClosed: (listener: (pid: number) => void) => {
      closed = listener;
      return () => undefined;
    },
    close: () => undefined,
  } satisfies WindowDockClient;
  const events: DockEvent[] = [];
  let listener: Parameters<DockWindow["subscribe"]>[0] | undefined;
  const state = {
    visible: true,
    maximized: false,
    bounds: { x: 100, y: 50, width: 800, height: 600 },
  };
  const window: DockWindow = {
    getBounds: () => state.bounds,
    setBounds: (bounds) => {
      state.bounds = bounds;
    },
    getZoomFactor: () => 1,
    isVisible: () => state.visible,
    isMinimized: () => false,
    isMaximized: () => state.maximized,
    isFullScreen: () => false,
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
    closeChrome: (pid: number) => closed?.(pid),
  };
}
const key = { threadId: "t", tabId: "a" };
const panel = { x: 400, y: 40, width: 300, height: 500 };

it("scales the panel width by zoom and puts Chrome beside the window", () => {
  assert.strictEqual(panelWidthToDips(100.4, 1.5), 151);
  assert.deepStrictEqual(sideFrame({ x: 100, y: 50, width: 500, height: 600 }, 300), {
    x: 600,
    y: 50,
    width: 300,
    height: 600,
  });
});

it("shrinks the window by the panel width, places Chrome beside it, and follows moves", async () => {
  const t = setup({ findsAfter: 2 });
  assert.isFalse(t.controller.setPanelRect(key, panel));
  await t.controller.dock(key, 9);
  assert.deepStrictEqual(t.state.bounds, { x: 100, y: 50, width: 500, height: 600 });
  assert.deepStrictEqual(
    t.calls.filter((c) => c[0] === "setFrame"),
    [["setFrame", 9, { x: 600, y: 50, width: 300, height: 600 }]],
  );
  t.state.bounds = { ...t.state.bounds, x: 110 };
  t.emitWindow("bounds");
  t.emitWindow("bounds");
  assert.deepStrictEqual(t.calls.filter((c) => c[0] === "setFrame").at(-1), [
    "setFrame",
    9,
    { x: 610, y: 50, width: 300, height: 600 },
  ]);
  assert.strictEqual(t.calls.filter((c) => c[0] === "setFrame").length, 2);
  assert.isTrue(t.controller.setPanelRect(key, null));
});

it("restores the window width when Chrome closes", async () => {
  const t = setup();
  await t.controller.dock(key, 9);
  assert.isTrue(t.controller.setPanelRect(key, panel));
  assert.strictEqual(t.state.bounds.width, 500);
  t.closeChrome(9);
  assert.strictEqual(t.state.bounds.width, 800);
  assert.deepStrictEqual(t.events, [{ type: "closed", key }]);
});

it("shares a Firefox process between tabs and restores T3 only after its last tab closes", async () => {
  const t = setup();
  await t.controller.dock(key, 42);
  t.controller.setPanelRect(key, panel);
  const second = { ...key, tabId: "firefox-second" };
  t.controller.setPanelRect(second, panel);
  await t.controller.dock(second, 42);
  expectWidth(500);
  t.controller.undock(key);
  expectWidth(500);
  t.controller.undock(second);
  expectWidth(800);
  assert.strictEqual(t.calls.filter((call) => call[0] === "watch").length, 1);
  assert.strictEqual(t.calls.filter((call) => call[0] === "unwatch").length, 1);
  function expectWidth(width: number) {
    assert.strictEqual(t.state.bounds.width, width);
  }
});

it("keeps the split when the window is maximized", async () => {
  const t = setup();
  await t.controller.dock(key, 9);
  t.controller.setPanelRect(key, panel);
  t.state.bounds = { x: 0, y: 0, width: 1600, height: 900 };
  t.state.maximized = true;
  t.emitWindow("bounds");
  assert.deepStrictEqual(t.state.bounds, { x: 0, y: 0, width: 1000, height: 900 });
  assert.deepStrictEqual(t.calls.filter((c) => c[0] === "setFrame").at(-1), [
    "setFrame",
    9,
    { x: 1000, y: 0, width: 600, height: 900 },
  ]);
});

it("raises Chrome when the window takes focus", async () => {
  const t = setup();
  await t.controller.dock(key, 9);
  t.controller.setPanelRect(key, panel);
  t.calls.length = 0;
  t.emitWindow("focus");
  assert.deepStrictEqual(t.calls, [["raise", 9]]);
});

it("reports a missing permission or window instead of docking", async () => {
  const denied = setup({ trusted: false });
  await denied.controller.dock(key, 9);
  assert.deepStrictEqual(denied.events, [{ type: "failed", key, reason: "no-permission" }]);
  const missing = setup({ findsAfter: 100 });
  await missing.controller.dock(key, 9);
  assert.deepStrictEqual(missing.events, [{ type: "failed", key, reason: "no-window" }]);
});

it("reports the tab closed when the user closes Chrome's window", async () => {
  const t = setup();
  await t.controller.dock(key, 9);
  t.closeChrome(9);
  assert.deepStrictEqual(t.events, [{ type: "closed", key }]);
});
