import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";

import * as Electron from "electron";

import * as DesktopAssets from "../app/DesktopAssets.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import { makeComponentLogger } from "../app/DesktopObservability.ts";
import * as DesktopState from "../app/DesktopState.ts";
import * as ElectronMenu from "../electron/ElectronMenu.ts";
import { getDesktopUrl } from "../electron/ElectronProtocol.ts";
import * as ElectronShell from "../electron/ElectronShell.ts";
import * as ElectronTheme from "../electron/ElectronTheme.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import { MINI_QQ_ACTIVATE_CHANNEL, MINI_QQ_OPEN_MAIN_ROUTE_CHANNEL } from "../ipc/channels.ts";
import * as DesktopWindow from "./DesktopWindow.ts";

const MINI_QQ_GLOBAL_SHORTCUT = "CommandOrControl+Shift+Space";
const MINI_QQ_HASH_ROUTE = "/__mini-qq";

const MINI_QQ_DEFAULT_WIDTH = 680;
const MINI_QQ_DEFAULT_HEIGHT = 480;
const MINI_QQ_MIN_WIDTH = 480;
const MINI_QQ_MIN_HEIGHT = 320;
const MINI_QQ_TOP_RATIO = 0.2;
const MINI_QQ_MIN_TOP_OFFSET_PX = 48;

const { logInfo: logMiniQqInfo, logWarning: logMiniQqWarning } =
  makeComponentLogger("desktop-mini-qq");

function getInitialBackgroundColor(shouldUseDarkColors: boolean): string {
  return shouldUseDarkColors ? "#0b0b0c" : "#ffffff";
}

function getIconOption(
  iconPaths: DesktopAssets.DesktopIconPaths,
  platform: NodeJS.Platform,
): { icon: string } | Record<string, never> {
  if (platform === "darwin") return {};
  const ext = platform === "win32" ? "ico" : "png";
  return Option.match(iconPaths[ext], {
    onNone: () => ({}),
    onSome: (icon) => ({ icon }),
  });
}

function getCursorDisplayId(): number | null {
  try {
    return Electron.screen.getDisplayNearestPoint(Electron.screen.getCursorScreenPoint()).id;
  } catch {
    return null;
  }
}

function resolveMiniQqBoundsForCursor(size?: {
  readonly width: number;
  readonly height: number;
}): Electron.Rectangle {
  const width = size?.width ?? MINI_QQ_DEFAULT_WIDTH;
  const height = size?.height ?? MINI_QQ_DEFAULT_HEIGHT;
  try {
    const cursor = Electron.screen.getCursorScreenPoint();
    const workArea = Electron.screen.getDisplayNearestPoint(cursor).workArea;
    const clampedWidth = Math.min(width, Math.max(MINI_QQ_MIN_WIDTH, workArea.width - 32));
    const clampedHeight = Math.min(height, Math.max(MINI_QQ_MIN_HEIGHT, workArea.height - 48));
    const x = Math.round(workArea.x + (workArea.width - clampedWidth) / 2);
    const y = Math.round(
      workArea.y +
        Math.max(MINI_QQ_MIN_TOP_OFFSET_PX, (workArea.height - clampedHeight) * MINI_QQ_TOP_RATIO),
    );
    return { x, y, width: clampedWidth, height: clampedHeight };
  } catch {
    return { x: 160, y: 120, width, height };
  }
}

function isSafeInternalRoutePath(routePath: string): boolean {
  const trimmed = routePath.trim();
  return trimmed.startsWith("/") && !trimmed.startsWith("//");
}

export class MiniQqWindow extends Context.Service<
  MiniQqWindow,
  {
    readonly toggle: Effect.Effect<void>;
    readonly show: Effect.Effect<void>;
    readonly hide: Effect.Effect<void>;
    readonly openInMainWindow: (routePath: string) => Effect.Effect<void>;
    readonly setMainRendererReady: (ready: boolean) => Effect.Effect<void>;
    readonly registerShortcut: Effect.Effect<void>;
  }
>()("@t3tools/desktop/window/MiniQqWindow") {}

const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const desktopState = yield* DesktopState.DesktopState;
  const assets = yield* DesktopAssets.DesktopAssets;
  const electronMenu = yield* ElectronMenu.ElectronMenu;
  const electronShell = yield* ElectronShell.ElectronShell;
  const electronTheme = yield* ElectronTheme.ElectronTheme;
  const electronWindow = yield* ElectronWindow.ElectronWindow;
  const desktopWindow = yield* DesktopWindow.DesktopWindow;

  const windowMutex = yield* Semaphore.make(1);
  const windowRef = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
  let shortcutRegistered = false;
  let userMovedWindow = false;
  let lastDisplayId: number | null = null;

  let pendingMainRoute: string | null = null;
  let mainListening: Electron.WebContents | null = null;
  let detachMainListening: (() => void) | null = null;

  const stopMainListening = () => {
    detachMainListening?.();
    detachMainListening = null;
    mainListening = null;
  };

  const servicesContext = yield* Effect.context<never>();
  const runPromise = Effect.runPromiseWith(servicesContext);
  const runSync = Effect.runSyncWith(servicesContext);

  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      stopMainListening();
      if (shortcutRegistered) {
        try {
          Electron.globalShortcut.unregister(MINI_QQ_GLOBAL_SHORTCUT);
        } catch {
          // Ignore teardown races if Electron already tore down globalShortcut.
        }
        shortcutRegistered = false;
      }
    }),
  );

  const flushMainRoute = Effect.gen(function* () {
    if (mainListening === null || pendingMainRoute === null) return;
    const main = yield* electronWindow.currentMainOrFirst;
    if (Option.isNone(main) || main.value.webContents !== mainListening) return;
    if (mainListening.isDestroyed()) {
      stopMainListening();
      return;
    }
    const routePath = pendingMainRoute;
    pendingMainRoute = null;
    mainListening.send(MINI_QQ_OPEN_MAIN_ROUTE_CHANNEL, routePath);
  });

  const startMainListening = Effect.gen(function* () {
    const main = yield* electronWindow.currentMainOrFirst;
    if (Option.isNone(main) || main.value.webContents.isDestroyed()) return;
    const webContents = main.value.webContents;
    if (mainListening === webContents) return;
    stopMainListening();
    mainListening = webContents;
    const onNavigation = (
      event: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>,
    ) => {
      if (event.isMainFrame && !event.isSameDocument) stopMainListening();
    };
    webContents.on("did-start-navigation", onNavigation);
    webContents.on("render-process-gone", stopMainListening);
    webContents.once("destroyed", stopMainListening);
    detachMainListening = () => {
      webContents.removeListener("did-start-navigation", onNavigation);
      webContents.removeListener("render-process-gone", stopMainListening);
      webContents.removeListener("destroyed", stopMainListening);
    };
  });

  const liveWindow = Effect.gen(function* () {
    const current = yield* Ref.get(windowRef);
    if (Option.isNone(current) || current.value.isDestroyed()) {
      return Option.none<Electron.BrowserWindow>();
    }
    return current;
  });

  const positionWindowIfNeeded = (window: Electron.BrowserWindow) => {
    try {
      const cursor = Electron.screen.getCursorScreenPoint();
      const targetDisplay = Electron.screen.getDisplayNearestPoint(cursor);
      if (!userMovedWindow || lastDisplayId !== targetDisplay.id) {
        const currentBounds = window.getBounds();
        const nextBounds = resolveMiniQqBoundsForCursor({
          width: currentBounds.width,
          height: currentBounds.height,
        });
        window.setBounds(nextBounds, false);
        lastDisplayId = targetDisplay.id;
      }
    } catch {
      // Ignore display lookup failures in headless/test environments.
    }
  };

  const ensureWindow = windowMutex.withPermits(1)(
    Effect.gen(function* () {
      const existing = yield* liveWindow;
      if (Option.isSome(existing)) {
        return existing;
      }
      if (yield* Ref.get(desktopState.quitting)) {
        return Option.none<Electron.BrowserWindow>();
      }

      const applicationBaseUrl = getDesktopUrl(environment.isDevelopment);
      const miniQqUrl = `${applicationBaseUrl}#${MINI_QQ_HASH_ROUTE}`;
      const shouldUseDarkColors = yield* electronTheme.shouldUseDarkColors;
      const iconPaths = yield* assets.iconPaths;
      const iconOption = getIconOption(iconPaths, environment.platform);
      const initialBounds = resolveMiniQqBoundsForCursor();

      const createdExit = yield* Effect.exit(
        electronWindow.create(
          {
            ...initialBounds,
            minWidth: MINI_QQ_MIN_WIDTH,
            minHeight: MINI_QQ_MIN_HEIGHT,
            show: false,
            frame: false,
            resizable: true,
            minimizable: false,
            maximizable: false,
            fullscreenable: false,
            alwaysOnTop: true,
            skipTaskbar: true,
            hasShadow: true,
            autoHideMenuBar: true,
            backgroundColor: getInitialBackgroundColor(shouldUseDarkColors),
            ...(environment.platform === "darwin"
              ? {
                  vibrancy: "under-window" as const,
                  visualEffectState: "active" as const,
                  roundedCorners: true,
                  hiddenInMissionControl: true,
                  disableAutoHideCursor: true,
                }
              : {}),
            ...iconOption,
            title: `${environment.displayName} (Quick Question)`,
            webPreferences: {
              preload: environment.preloadPath,
              backgroundThrottling: false,
              contextIsolation: true,
              nodeIntegration: false,
              sandbox: true,
              webviewTag: false,
            },
          },
          { auxiliary: true, trustedIpc: true },
        ),
      );

      if (createdExit._tag === "Failure") {
        yield* logMiniQqWarning("failed to create Mini QQ window", {
          cause: createdExit.cause,
        });
        return Option.none<Electron.BrowserWindow>();
      }

      const window = createdExit.value;
      userMovedWindow = false;
      lastDisplayId = getCursorDisplayId();

      if (environment.platform === "darwin") {
        window.setAutoHideCursor(false);
        window.setAlwaysOnTop(true, "floating");
        window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
      }

      window.on("move", () => {
        if (window.isVisible()) {
          userMovedWindow = true;
        }
      });

      window.on("close", (event) => {
        // Hide rather than destroy unless the app is quitting, keeping active /qq turns warm.
        const quitting = runSync(Ref.get(desktopState.quitting));
        if (!quitting && !window.isDestroyed()) {
          event.preventDefault();
          window.hide();
        }
      });

      window.once("closed", () => {
        void runPromise(Ref.set(windowRef, Option.none()));
      });

      window.webContents.setWindowOpenHandler(({ url }) => {
        if (Option.isSome(ElectronShell.parseSafeExternalUrl(url))) {
          void runPromise(electronShell.openExternal(url));
        }
        return { action: "deny" };
      });

      window.webContents.on("will-navigate", (event, url) => {
        if (
          DesktopWindow.isSameOriginRendererNavigation({
            applicationUrl: applicationBaseUrl,
            navigationUrl: url,
          })
        ) {
          return;
        }
        event.preventDefault();
        if (Option.isSome(ElectronShell.parseSafeExternalUrl(url))) {
          void runPromise(electronShell.openExternal(url));
        }
      });

      window.webContents.on("context-menu", (event, params) => {
        event.preventDefault();
        if (window.isDestroyed() || window.webContents.isDestroyed()) return;
        window.webContents.focus();
        const template: Electron.MenuItemConstructorOptions[] = [];
        if (params.misspelledWord) {
          for (const suggestion of params.dictionarySuggestions.slice(0, 5)) {
            template.push({
              label: suggestion,
              click: () => {
                if (!window.webContents.isDestroyed()) {
                  window.webContents.replaceMisspelling(suggestion);
                }
              },
            });
          }
          template.push({ type: "separator" });
        }
        if (Option.isSome(ElectronShell.parseSafeExternalUrl(params.linkURL))) {
          template.push(
            {
              label: "Copy Link",
              click: () => {
                void runPromise(electronShell.copyText(params.linkURL));
              },
            },
            { type: "separator" },
          );
        }
        template.push(
          { role: "cut", enabled: params.editFlags.canCut },
          { role: "copy", enabled: params.editFlags.canCopy },
          { role: "paste", enabled: params.editFlags.canPaste },
          { role: "selectAll", enabled: params.editFlags.canSelectAll },
        );
        void runPromise(
          electronMenu.popupTemplate({
            window,
            template,
            ...(params.frame ? { frame: params.frame } : {}),
          }),
        );
      });

      yield* Ref.set(windowRef, Option.some(window));
      yield* Effect.promise(() => window.loadURL(miniQqUrl).catch(() => undefined));
      return Option.some(window);
    }),
  );

  const hide = Effect.gen(function* () {
    const current = yield* liveWindow;
    if (Option.isNone(current)) return;
    yield* Effect.sync(() => {
      if (!current.value.isDestroyed() && current.value.isVisible()) {
        current.value.hide();
      }
    });
  });

  const show = Effect.gen(function* () {
    const ensured = yield* ensureWindow;
    if (Option.isNone(ensured)) return;
    const window = ensured.value;
    if (window.isDestroyed()) return;

    positionWindowIfNeeded(window);
    yield* electronWindow.reveal(window);
    yield* Effect.sync(() => {
      if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
        window.webContents.focus();
        window.webContents.send(MINI_QQ_ACTIVATE_CHANNEL, { focusComposer: true });
      }
    });
  });

  const toggle = Effect.gen(function* () {
    const current = yield* liveWindow;
    if (Option.isSome(current) && current.value.isVisible() && current.value.isFocused()) {
      yield* hide;
      return;
    }
    yield* show;
  });

  const openInMainWindow = Effect.fn("MiniQqWindow.openInMainWindow")(function* (
    routePath: string,
  ) {
    if (!isSafeInternalRoutePath(routePath)) {
      yield* logMiniQqWarning("ignoring unsafe Mini QQ main-window route", { routePath });
      return;
    }
    yield* hide;
    pendingMainRoute = routePath.trim();
    yield* desktopWindow.activate.pipe(Effect.ignore);
    yield* flushMainRoute;
  });

  const setMainRendererReady = Effect.fn("MiniQqWindow.setMainRendererReady")(function* (
    ready: boolean,
  ) {
    if (ready) {
      yield* startMainListening;
      yield* flushMainRoute;
    } else {
      stopMainListening();
    }
  });

  const registerShortcut = Effect.gen(function* () {
    if (shortcutRegistered) return;
    const registered = yield* Effect.sync(() => {
      try {
        return Electron.globalShortcut.register(MINI_QQ_GLOBAL_SHORTCUT, () => {
          void runPromise(toggle);
        });
      } catch {
        return false;
      }
    });
    shortcutRegistered = registered;
    if (registered) {
      yield* logMiniQqInfo("registered global Quick Question shortcut", {
        accelerator: MINI_QQ_GLOBAL_SHORTCUT,
      });
    } else {
      yield* logMiniQqWarning("could not register global Quick Question shortcut", {
        accelerator: MINI_QQ_GLOBAL_SHORTCUT,
      });
    }
  });

  return MiniQqWindow.of({
    toggle,
    show,
    hide,
    openInMainWindow,
    setMainRendererReady,
    registerShortcut,
  });
});

export const layer = Layer.effect(MiniQqWindow, make);
