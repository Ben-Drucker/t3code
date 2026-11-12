import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import type * as Electron from "electron";
import { beforeEach, vi } from "vite-plus/test";

const { globalShortcutRegisterMock, globalShortcutUnregisterMock } = vi.hoisted(() => ({
  globalShortcutRegisterMock: vi.fn<() => boolean>(() => true),
  globalShortcutUnregisterMock: vi.fn<() => void>(),
}));

vi.mock("electron", () => ({
  globalShortcut: {
    register: globalShortcutRegisterMock,
    unregister: globalShortcutUnregisterMock,
  },
}));

import * as DesktopAssets from "../app/DesktopAssets.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopState from "../app/DesktopState.ts";
import * as ElectronMenu from "../electron/ElectronMenu.ts";
import { getDesktopUrl } from "../electron/ElectronProtocol.ts";
import * as ElectronShell from "../electron/ElectronShell.ts";
import * as ElectronTheme from "../electron/ElectronTheme.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import { MINI_QQ_ACTIVATE_CHANNEL, MINI_QQ_OPEN_MAIN_ROUTE_CHANNEL } from "../ipc/channels.ts";
import * as DesktopWindow from "./DesktopWindow.ts";
import * as MiniQqWindow from "./MiniQqWindow.ts";

function makeFakeBrowserWindow() {
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  const wcListeners = new Map<string, Array<(...args: unknown[]) => void>>();
  const sent: Array<{ readonly channel: string; readonly payload: unknown }> = [];
  let visible = false;
  let focused = false;
  let destroyed = false;
  let loadedUrl: string | null = null;

  const window = {
    isDestroyed: () => destroyed,
    isVisible: () => visible,
    isFocused: () => focused,
    isMinimized: () => false,
    getBounds: () => ({ x: 160, y: 120, width: 680, height: 480 }),
    setBounds: vi.fn(),
    restore: vi.fn(),
    show: vi.fn(() => {
      visible = true;
    }),
    hide: vi.fn(() => {
      visible = false;
      focused = false;
    }),
    focus: vi.fn(() => {
      focused = true;
    }),
    setAutoHideCursor: vi.fn(),
    setAlwaysOnTop: vi.fn(),
    setVisibleOnAllWorkspaces: vi.fn(),
    loadURL: vi.fn(async (url: string) => {
      loadedUrl = url;
    }),
    on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
      const list = listeners.get(event) ?? [];
      list.push(cb);
      listeners.set(event, list);
      return window;
    }),
    once: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
      const list = listeners.get(event) ?? [];
      list.push(cb);
      listeners.set(event, list);
      return window;
    }),
    webContents: {
      isDestroyed: () => destroyed,
      isLoadingMainFrame: () => false,
      focus: vi.fn(),
      send: vi.fn((channel: string, payload: unknown) => {
        sent.push({ channel, payload });
      }),
      setWindowOpenHandler: vi.fn(),
      on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
        const list = wcListeners.get(event) ?? [];
        list.push(cb);
        wcListeners.set(event, list);
      }),
      once: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
        const list = wcListeners.get(event) ?? [];
        list.push(cb);
        wcListeners.set(event, list);
      }),
      removeListener: vi.fn(),
    },
    emit(event: string, ...args: unknown[]) {
      for (const cb of listeners.get(event) ?? []) {
        cb(...args);
      }
    },
    getLoadedUrl: () => loadedUrl,
    sent,
  };

  return window;
}

describe("MiniQqWindow", () => {
  beforeEach(() => {
    globalShortcutRegisterMock.mockReset().mockReturnValue(true);
    globalShortcutUnregisterMock.mockReset();
  });

  it.effect(
    "creates an auxiliary trusted window once, hides on close, and toggles visibility",
    () =>
      Effect.gen(function* () {
        const quitting = yield* Ref.make(false);
        const created: Array<{
          readonly options: Electron.BrowserWindowConstructorOptions;
          readonly behavior:
            | { readonly auxiliary?: boolean; readonly trustedIpc?: boolean }
            | undefined;
          readonly window: ReturnType<typeof makeFakeBrowserWindow>;
        }> = [];

        const service = yield* MiniQqWindow.MiniQqWindow.pipe(
          Effect.provide(
            MiniQqWindow.layer.pipe(
              Layer.provide(
                Layer.mergeAll(
                  Layer.succeed(DesktopEnvironment.DesktopEnvironment, {
                    platform: "darwin",
                    displayName: "T3 Code",
                    isDevelopment: false,
                    preloadPath: "/repo/dist-electron/preload.mjs",
                  } as unknown as DesktopEnvironment.DesktopEnvironment["Service"]),
                  Layer.succeed(DesktopAssets.DesktopAssets, {
                    iconPaths: Effect.succeed({
                      png: Option.none(),
                      ico: Option.none(),
                      icns: Option.none(),
                    }),
                  } as unknown as DesktopAssets.DesktopAssets["Service"]),
                  Layer.succeed(DesktopState.DesktopState, {
                    quitting,
                  } as DesktopState.DesktopState["Service"]),
                  Layer.mock(ElectronMenu.ElectronMenu, {}),
                  Layer.mock(ElectronShell.ElectronShell, {}),
                  Layer.mock(ElectronTheme.ElectronTheme, {
                    shouldUseDarkColors: Effect.succeed(true),
                  }),
                  Layer.mock(DesktopWindow.DesktopWindow, {
                    activate: Effect.void,
                  }),
                  Layer.mock(ElectronWindow.ElectronWindow, {
                    create: (options, behavior) =>
                      Effect.sync(() => {
                        const fake = makeFakeBrowserWindow();
                        created.push({ options, behavior, window: fake });
                        return fake as unknown as Electron.BrowserWindow;
                      }),
                    reveal: (win) =>
                      Effect.sync(() => {
                        win.show();
                        win.focus();
                      }),
                    currentMainOrFirst: Effect.succeedNone,
                  }),
                ),
              ),
            ),
          ),
        );

        yield* service.toggle;
        assert.equal(created.length, 1);
        assert.deepEqual(created[0]!.behavior, { auxiliary: true, trustedIpc: true });
        assert.equal(created[0]!.window.getLoadedUrl(), `${getDesktopUrl(false)}#/__mini-qq`);
        assert.isTrue(created[0]!.window.isVisible());
        assert.deepEqual(created[0]!.window.sent, [
          { channel: MINI_QQ_ACTIVATE_CHANNEL, payload: { focusComposer: true } },
        ]);

        // Toggling while visible and focused hides without destroying.
        yield* service.toggle;
        assert.isFalse(created[0]!.window.isVisible());
        assert.equal(created.length, 1);

        // Toggling again reuses the warm window.
        yield* service.toggle;
        assert.isTrue(created[0]!.window.isVisible());
        assert.equal(created.length, 1);

        // Closing while app is not quitting prevents destruction and hides instead.
        let prevented = false;
        created[0]!.window.emit("close", {
          preventDefault: () => {
            prevented = true;
          },
        });
        assert.isTrue(prevented);
        assert.isFalse(created[0]!.window.isVisible());
      }).pipe(Effect.scoped),
  );

  it.effect("queues openInMainWindow until the main renderer reports ready", () =>
    Effect.gen(function* () {
      const quitting = yield* Ref.make(false);
      const mainWindow = makeFakeBrowserWindow();
      let revealedMain = 0;

      const service = yield* MiniQqWindow.MiniQqWindow.pipe(
        Effect.provide(
          MiniQqWindow.layer.pipe(
            Layer.provide(
              Layer.mergeAll(
                Layer.succeed(DesktopEnvironment.DesktopEnvironment, {
                  platform: "darwin",
                  displayName: "T3 Code",
                  isDevelopment: false,
                  preloadPath: "/repo/dist-electron/preload.mjs",
                } as unknown as DesktopEnvironment.DesktopEnvironment["Service"]),
                Layer.succeed(DesktopAssets.DesktopAssets, {
                  iconPaths: Effect.succeed({
                    png: Option.none(),
                    ico: Option.none(),
                    icns: Option.none(),
                  }),
                } as unknown as DesktopAssets.DesktopAssets["Service"]),
                Layer.succeed(DesktopState.DesktopState, {
                  quitting,
                } as DesktopState.DesktopState["Service"]),
                Layer.mock(ElectronMenu.ElectronMenu, {}),
                Layer.mock(ElectronShell.ElectronShell, {}),
                Layer.mock(ElectronTheme.ElectronTheme, {
                  shouldUseDarkColors: Effect.succeed(false),
                }),
                Layer.mock(DesktopWindow.DesktopWindow, {
                  activate: Effect.sync(() => {
                    revealedMain += 1;
                  }),
                }),
                Layer.mock(ElectronWindow.ElectronWindow, {
                  currentMainOrFirst: Effect.succeedSome(
                    mainWindow as unknown as Electron.BrowserWindow,
                  ),
                }),
              ),
            ),
          ),
        ),
      );

      yield* service.openInMainWindow("/env-local/thread-123");
      assert.equal(revealedMain, 1);
      assert.deepEqual(mainWindow.sent, []);

      yield* service.setMainRendererReady(true);
      assert.deepEqual(mainWindow.sent, [
        {
          channel: MINI_QQ_OPEN_MAIN_ROUTE_CHANNEL,
          payload: "/env-local/thread-123",
        },
      ]);
    }).pipe(Effect.scoped),
  );
});
