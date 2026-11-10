// @effect-diagnostics nodeBuiltinImport:off -- Builds the dev helper with the Xcode toolchain.
import type { DesktopPreviewDockRectInput, DesktopPreviewDockStatus } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as DesktopBrowserHost from "../preview/DesktopBrowserHost.ts";
import { startWindowDockClient, type WindowDockClient } from "./WindowDockClient.ts";
import { WindowDockController, type DockEvent, type DockWindow } from "./WindowDockController.ts";

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);
const HELPER_NAME = "t3-window-dock";

class WindowDockBuildError extends Schema.TaggedError<WindowDockBuildError>()(
  "WindowDockBuildError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not build the window dock helper.";
  }
}

export class WindowDock extends Context.Service<
  WindowDock,
  {
    readonly status: Effect.Effect<DesktopPreviewDockStatus>;
    /** Shows the system Accessibility prompt when T3 Code is not trusted yet. */
    readonly requestPermission: Effect.Effect<boolean>;
    readonly setPanelRect: (input: DesktopPreviewDockRectInput) => Effect.Effect<void>;
  }
>()("@t3tools/desktop/windowDock/WindowDock") {}

const toDockWindow = (window: Electron.BrowserWindow): DockWindow => ({
  getContentBounds: () => window.getContentBounds(),
  getZoomFactor: () => window.webContents.getZoomFactor(),
  isVisible: () => window.isVisible(),
  isMinimized: () => window.isMinimized(),
  isFullScreen: () => window.isFullScreen(),
  isFocused: () => window.isFocused(),
  subscribe: (listener) => {
    const target = window as unknown as Pick<NodeJS.EventEmitter, "on" | "off">;
    const bounds = () => listener("bounds");
    const focus = () => listener("focus");
    const visibility = () => listener("visibility");
    const boundsEvents = ["move", "resize", "moved", "resized"] as const;
    const visibilityEvents = ["show", "hide", "minimize", "restore"] as const;
    const fullScreenEvents = ["enter-full-screen", "leave-full-screen"] as const;
    for (const name of boundsEvents) target.on(name, bounds);
    for (const name of [...visibilityEvents, ...fullScreenEvents]) target.on(name, visibility);
    window.on("focus", focus);
    return () => {
      if (window.isDestroyed()) return;
      for (const name of boundsEvents) target.off(name, bounds);
      for (const name of [...visibilityEvents, ...fullScreenEvents]) target.off(name, visibility);
      window.off("focus", focus);
    };
  },
});

export const layer = Layer.effect(
  WindowDock,
  Effect.gen(function* () {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const fileSystem = yield* FileSystem.FileSystem;
    const electronWindow = yield* ElectronWindow.ElectronWindow;
    const browserHost = yield* DesktopBrowserHost.DesktopBrowserHost;
    const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());
    const supported = environment.platform === "darwin";

    const resolveHelper = Effect.gen(function* () {
      if (environment.isPackaged) {
        return Option.some(
          environment.path.join(environment.resourcesPath, "window-dock", HELPER_NAME),
        );
      }
      const output = environment.path.join(
        environment.rootDir,
        "native/window-dock/build",
        HELPER_NAME,
      );
      if (yield* fileSystem.exists(output).pipe(Effect.orElseSucceed(() => false))) {
        return Option.some(output);
      }
      const source = environment.path.join(environment.rootDir, "native/window-dock/main.swift");
      yield* fileSystem.makeDirectory(environment.path.dirname(output), { recursive: true });
      return yield* Effect.tryPromise({
        try: () => execFile("swiftc", ["-O", source, "-o", output]),
        catch: (cause) => new WindowDockBuildError({ cause }),
      }).pipe(
        Effect.as(Option.some(output)),
        Effect.catch((cause) =>
          Effect.logWarning("Could not build the window dock helper", cause).pipe(
            Effect.as(Option.none<string>()),
          ),
        ),
      );
    });

    let client: Promise<WindowDockClient | undefined> | undefined;
    const getClient = (): Promise<WindowDockClient | undefined> => {
      if (!supported) return Promise.resolve(undefined);
      const current = client;
      if (current !== undefined) {
        // A helper that exited is started again on the next use.
        return current.then((existing) => {
          if (existing === undefined || existing.alive()) return existing;
          client = undefined;
          return getClient();
        });
      }
      client = runPromise(resolveHelper).then((path) =>
        Option.isSome(path) ? startWindowDockClient(path.value) : undefined,
      );
      return client;
    };

    let controller: Promise<WindowDockController | undefined> | undefined;
    const getController = (): Promise<WindowDockController | undefined> => {
      controller ??= getClient().then((started) => {
        if (!started) return undefined;
        return new WindowDockController({
          helper: started,
          mainWindow: () => {
            const window = Option.getOrUndefined(runSyncMain());
            return window && !window.isDestroyed() ? toDockWindow(window) : undefined;
          },
          emit: emitDockEvent,
        });
      });
      return controller;
    };
    let mainWindow: Option.Option<Electron.BrowserWindow> = Option.none();
    const runSyncMain = () => mainWindow;
    const refreshMain = electronWindow.main.pipe(
      Effect.tap((window) => Effect.sync(() => (mainWindow = window))),
    );

    const emitDockEvent = (event: DockEvent) => {
      if (event.type === "closed") browserHost.emitDockEvent({ type: "dockClosed", ...event.key });
      else browserHost.emitDockEvent({ type: "dockFailed", ...event.key, reason: event.reason });
    };

    yield* browserHost.dockCommands.pipe(
      Stream.runForEach((command) =>
        Effect.promise(async () => {
          if (!supported) {
            if (command.type === "dock")
              emitDockEvent({ type: "failed", key: command.key, reason: "unsupported" });
            return;
          }
          const docks = await getController();
          if (!docks) {
            if (command.type === "dock")
              emitDockEvent({ type: "failed", key: command.key, reason: "unsupported" });
            return;
          }
          await runPromise(refreshMain);
          if (command.type === "dock") await docks.dock(command.key, command.pid);
          else docks.undock(command.key);
        }),
      ),
      Effect.forkScoped,
    );
    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        (await controller)?.dispose();
        (await client)?.close();
      }),
    );

    return WindowDock.of({
      status: Effect.promise(async () => ({
        supported,
        trusted: (await (await getClient())?.checkTrusted(false)) === true,
      })),
      requestPermission: Effect.promise(
        async () => (await (await getClient())?.checkTrusted(true)) === true,
      ),
      setPanelRect: Effect.fn("WindowDock.setPanelRect")(function* (input) {
        yield* refreshMain;
        const docks = yield* Effect.promise(getController);
        docks?.setPanelRect({ threadId: input.threadId, tabId: input.tabId }, input.rect);
      }),
    });
  }),
);
