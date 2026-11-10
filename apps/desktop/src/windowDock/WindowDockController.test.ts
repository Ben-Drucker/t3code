import { assert, it } from "@effect/vitest";

import type { WindowDockClient } from "./WindowDockClient.ts";
import { WindowDockController, type DockEvent, type DockWindow } from "./WindowDockController.ts";
import { panelToScreenFrame } from "./WindowDockGeometry.ts";

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
  const state = { visible: true, bounds: { x: 100, y: 50, width: 800, height: 600 } };
  const window: DockWindow = {
    getContentBounds: () => state.bounds,
    getZoomFactor: () => 1,
    isVisible: () => state.visible,
    isMinimized: () => false,
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

it("converts panel CSS pixels through zoom and content bounds only", () => {
  assert.deepStrictEqual(
    panelToScreenFrame({
      panel: { x: 10.4, y: 20, width: 100, height: 50 },
      contentBounds: { x: 100, y: 50, width: 800, height: 600 },
      zoomFactor: 1.5,
    }),
    { x: 116, y: 80, width: 150, height: 75 },
  );
  assert.isNull(
    panelToScreenFrame({
      panel: { x: 0, y: 0, width: 0, height: 10 },
      contentBounds: { x: 0, y: 0, width: 1, height: 1 },
      zoomFactor: 1,
    }),
  );
});

it("applies a panel reported before Chrome finished opening, and follows window moves", async () => {
  const t = setup({ findsAfter: 2 });
  t.controller.setPanelRect(key, panel);
  await t.controller.dock(key, 9);
  assert.deepStrictEqual(
    t.calls.filter((c) => c[0] === "setFrame"),
    [["setFrame", 9, { x: 500, y: 90, width: 300, height: 500 }]],
  );
  t.state.bounds = { ...t.state.bounds, x: 110 };
  t.emitWindow("bounds");
  t.emitWindow("bounds");
  assert.deepStrictEqual(t.calls.filter((c) => c[0] === "setFrame").at(-1), [
    "setFrame",
    9,
    { x: 510, y: 90, width: 300, height: 500 },
  ]);
  assert.strictEqual(t.calls.filter((c) => c[0] === "setFrame").length, 2);
});

it("minimizes Chrome while the panel is hidden and raises it on reveal and focus", async () => {
  const t = setup();
  await t.controller.dock(key, 9);
  t.controller.setPanelRect(key, null);
  assert.deepStrictEqual(t.calls.at(-1), ["minimize", 9, true]);
  t.controller.setPanelRect(key, panel);
  assert.deepStrictEqual(
    t.calls.slice(-3).map((c) => c[0]),
    ["minimize", "setFrame", "raise"],
  );
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
