/** Routes opens between Firefox (docked) and the built-in browser with no real Firefox, Chrome, or window helper. */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import {
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  type PreviewAutomationStatus,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import { beforeEach, expect, vi } from "vite-plus/test";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as Broker from "../mcp/PreviewAutomationBroker.ts";
import * as DesktopChannel from "./DesktopBrowserChannel.ts";
import * as Manager from "./Manager.ts";
import * as PreviewAgentActivity from "./PreviewAgentActivity.ts";
import * as PreviewBrowser from "./PreviewBrowser.ts";
import * as ServerBrowser from "./ServerBrowser.ts";

const fake = vi.hoisted(() => {
  const waiters: Array<() => void> = [];
  const state = {
    /** Firefox opens that fail before one succeeds. */
    failOpens: 0,
    firefoxOpens: [] as string[],
    managedOpens: [] as string[],
    builtinOpens: 0,
    interleaveOpen: false,
    concurrentTab: undefined as string | undefined,
    hostReady: undefined as Promise<void> | undefined,
    eventsReady: undefined as Promise<void> | undefined,
    dockChanges: undefined as
      | { publish: (change: unknown) => void; ready: Promise<void> }
      | undefined,
    changed: () => {
      for (const waiter of waiters.splice(0)) waiter();
    },
    /** Resolves once `done` holds, re-checked whenever a mock records something. */
    until: async (done: () => boolean) => {
      while (!done()) await new Promise<void>((resolve) => waiters.push(resolve));
    },
  };
  return state;
});

vi.mock("./FirefoxServerBrowser.ts", async () => {
  const Effect = await import("effect/Effect");
  return {
    makeBrowser: () =>
      Effect.succeed({
        liveTabs: [],
        execute: async () => {
          fake.firefoxOpens.push("execute");
          fake.changed();
          if (fake.failOpens > 0) {
            fake.failOpens -= 1;
            throw new Error("Marionette is not ready");
          }
          return {
            available: true,
            visible: true,
            tabId: "firefox-tab",
            url: null,
            title: null,
            loading: false,
            backend: "firefox",
            tabs: [],
          };
        },
        openManaged: async (snapshot: { tabId: string }) => {
          fake.managedOpens.push(snapshot.tabId);
          fake.changed();
          if (fake.failOpens > 0) {
            fake.failOpens -= 1;
            throw new Error("Marionette is not ready");
          }
        },
        closeTab: async () => {},
        history: async () => {},
        close: async () => {},
      }),
  };
});

vi.mock("./ServerBrowserContexts.ts", () => ({
  presentAsChrome: async () => {},
  ServerBrowserContexts: class {
    async contextFor() {
      fake.builtinOpens += 1;
      fake.changed();
      throw new Error("The built-in browser is not available in this test.");
    }
    async close() {}
    async closeDocked() {}
    async clearProfile() {}
  },
}));

const thread = {
  threadId: ThreadId.make("firefox-routing-thread"),
  providerSessionId: "agent-a",
  providerInstanceId: ProviderInstanceId.make("codex"),
};
const scope = {
  environmentId: EnvironmentId.make("firefox-routing-environment"),
  thread,
  client: undefined,
  requestNamespace: "firefox-routing",
  capabilities: new Set(["preview"] as const),
  issuedAt: 1,
};

const dependencies = Layer.mergeAll(
  Layer.effect(
    Broker.PreviewAutomationBroker,
    Effect.gen(function* () {
      const broker = yield* Broker.PreviewAutomationBroker;
      const connected = Promise.withResolvers<void>();
      fake.hostReady = connected.promise;
      return Broker.PreviewAutomationBroker.of({
        ...broker,
        connect: (host, options) =>
          broker
            .connect(host, options)
            .pipe(Effect.tap(() => Effect.sync(() => connected.resolve()))),
      });
    }),
  ).pipe(Layer.provide(Broker.layer)),
  Layer.effect(
    Manager.PreviewManager,
    Effect.gen(function* () {
      const manager = yield* Manager.PreviewManager;
      const subscribed = Promise.withResolvers<void>();
      fake.eventsReady = subscribed.promise;
      return Manager.PreviewManager.of({
        ...manager,
        subscribeEvents: manager.subscribeEvents.pipe(
          Effect.tap(() => Effect.sync(() => subscribed.resolve())),
        ),
        events: Stream.unwrap(
          manager.subscribeEvents.pipe(
            Effect.tap(() => Effect.sync(() => subscribed.resolve())),
            Effect.map(Stream.fromSubscription),
          ),
        ),
        open: (input) =>
          Effect.gen(function* () {
            if (fake.interleaveOpen && fake.managedOpens.length === 1) {
              fake.interleaveOpen = false;
              const concurrent = yield* manager.open({
                threadId: input.threadId,
                runtime: "server",
                reveal: false,
              });
              fake.concurrentTab = concurrent.tabId;
            }
            return yield* manager.open(input);
          }),
      });
    }),
  ).pipe(Layer.provide(Manager.layer)),
  Layer.succeed(HostProcess.Platform, "darwin"),
  Layer.succeed(ServerEnvironment.ServerEnvironment, {
    getEnvironmentId: Effect.succeed(scope.environmentId),
    getDescriptor: Effect.die("unused descriptor"),
  }),
  Layer.succeed(PreviewBrowser.PreviewBrowser, {
    executable: Effect.die("mock Chromium does not need an executable"),
    installed: Effect.die("mock Chromium does not need an executable"),
  }),
  Layer.effect(
    DesktopChannel.DesktopBrowserChannel,
    Effect.gen(function* () {
      const dockChanges = yield* PubSub.unbounded<DesktopChannel.DockChange>();
      const subscribed = Promise.withResolvers<void>();
      fake.dockChanges = {
        publish: (change) => PubSub.publishUnsafe(dockChanges, change as DesktopChannel.DockChange),
        ready: subscribed.promise,
      };
      return DesktopChannel.DesktopBrowserChannel.of({
        available: true,
        awaitAttached: () => Effect.succeed(false),
        detached: Stream.empty,
        attached: Stream.empty,
        isAttached: () => Effect.succeed(false),
        isShown: () => false,
        awaitShown: () => Effect.succeed(false),
        loadFailure: () => undefined,
        endpoint: () => Effect.die("no desktop tab in this test"),
        pointer: () => Effect.void,
        dock: () => Effect.void,
        undock: () => Effect.void,
        dockChanges: Stream.fromPubSub(dockChanges).pipe(
          Stream.tap(() => Effect.void),
          Stream.onStart(Effect.sync(() => subscribed.resolve())),
        ),
        turn: () => Effect.void,
      });
    }),
  ),
  PreviewAgentActivity.layer,
).pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-firefox-routing-" })),
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);
const layer = ServerBrowser.layer.pipe(Layer.provideMerge(dependencies));

beforeEach(() => {
  fake.failOpens = 0;
  fake.firefoxOpens.length = 0;
  fake.managedOpens.length = 0;
  fake.builtinOpens = 0;
  fake.interleaveOpen = false;
  fake.concurrentTab = undefined;
});

const awaitReady = Effect.all([
  Effect.promise(() => fake.hostReady!),
  Effect.promise(() => fake.eventsReady!),
]);

const reportMode = (mode: "builtin" | "firefox-docked") =>
  Effect.gen(function* () {
    const browser = yield* ServerBrowser.ServerBrowser;
    const report = yield* browser.profileReporter;
    return (previewBrowserMode: typeof mode = mode) =>
      report(
        { profiles: [], defaultProfileId: "default", previewBrowserMode },
        "desktop-bootstrap",
      );
  });

const manualOpen = Effect.gen(function* () {
  const manager = yield* Manager.PreviewManager;
  return yield* manager.open({ threadId: thread.threadId, runtime: "server", reveal: false });
});

const agentOpen = Effect.gen(function* () {
  const broker = yield* Broker.PreviewAutomationBroker;
  return yield* broker
    .invoke<PreviewAutomationStatus>({
      scope,
      operation: "open",
      input: { reuseExistingTab: false, show: false },
    })
    .pipe(Effect.exit);
});

it.effect("a paired desktop cannot replace the host desktop's Firefox mode", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const browser = yield* ServerBrowser.ServerBrowser;
      const local = yield* browser.profileReporter;
      const paired = yield* browser.profileReporter;
      yield* local(
        { profiles: [], defaultProfileId: "default", previewBrowserMode: "firefox-docked" },
        "desktop-bootstrap",
      );
      yield* paired(
        { profiles: [], defaultProfileId: "default", previewBrowserMode: "builtin" },
        "one-time-token",
      );
      yield* awaitReady;

      const opened = yield* agentOpen;
      expect(opened._tag).toBe("Success");
      expect(fake.firefoxOpens).toHaveLength(1);
      expect(fake.builtinOpens).toBe(0);
    }),
  ).pipe(Effect.provide(layer)),
);

it.effect(
  "a manual open that fell back to the built-in browser tries Firefox again next time",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* ServerBrowser.ServerBrowser;
        const report = yield* reportMode("firefox-docked");
        yield* report();
        yield* awaitReady;

        fake.failOpens = 1;
        yield* manualOpen;
        // The failed tab reopens once in the built-in browser and is not offered to Firefox again.
        yield* Effect.promise(() => fake.until(() => fake.builtinOpens >= 1));
        expect(fake.managedOpens).toHaveLength(1);

        // The user closes the fallback tab, so the next open creates a new one.
        const manager = yield* Manager.PreviewManager;
        const { sessions } = yield* manager.list({ threadId: thread.threadId });
        for (const session of sessions) {
          yield* manager.close({ threadId: thread.threadId, tabId: session.tabId });
        }
        yield* manualOpen;
        yield* Effect.promise(() =>
          fake.until(() => fake.managedOpens.length >= 2 || fake.builtinOpens >= 2),
        );
        expect(fake.managedOpens).toHaveLength(2);
        expect(fake.builtinOpens).toBe(1);
      }),
    ).pipe(Effect.provide(layer)),
);

it.effect(
  "an agent open that fell back to the built-in browser tries Firefox again next time",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* ServerBrowser.ServerBrowser;
        const report = yield* reportMode("firefox-docked");
        yield* report();

        yield* awaitReady;
        fake.failOpens = 1;
        yield* agentOpen;
        expect(fake.firefoxOpens).toHaveLength(1);
        expect(fake.builtinOpens).toBe(1);

        const second = yield* agentOpen;
        expect(fake.firefoxOpens).toHaveLength(2);
        expect(fake.builtinOpens).toBe(1);
        expect(second._tag).toBe("Success");
      }),
    ).pipe(Effect.provide(layer)),
);

it.effect("a Firefox the desktop cannot dock stays off until the mode is reported again", () =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* ServerBrowser.ServerBrowser;
      const report = yield* reportMode("firefox-docked");
      yield* report();
      yield* Effect.promise(() => fake.dockChanges!.ready);

      const opened = yield* manualOpen;
      yield* Effect.promise(() => fake.until(() => fake.managedOpens.length >= 1));
      fake.dockChanges!.publish({
        type: "failed",
        key: { threadId: thread.threadId, tabId: opened.tabId },
        reason: "no-permission",
      });
      yield* Effect.promise(() => fake.until(() => fake.builtinOpens >= 1));

      // Without the user's help the dock fails the same way, so Firefox is not opened again.
      yield* manualOpen;
      yield* Effect.promise(() => fake.until(() => fake.builtinOpens >= 2));
      expect(fake.managedOpens).toHaveLength(1);

      // Reporting the same mode again, as a reconnected client does, tries Firefox once more.
      yield* report();
      yield* manualOpen;
      yield* Effect.promise(() =>
        fake.until(() => fake.managedOpens.length >= 2 || fake.builtinOpens >= 3),
      );
      expect(fake.managedOpens).toHaveLength(2);
      expect(fake.builtinOpens).toBe(2);
    }),
  ).pipe(Effect.provide(layer)),
);

it.effect("a Firefox window the desktop could not find is retried by the next open", () =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* ServerBrowser.ServerBrowser;
      const report = yield* reportMode("firefox-docked");
      yield* report();
      yield* Effect.promise(() => fake.dockChanges!.ready);

      const opened = yield* manualOpen;
      yield* Effect.promise(() => fake.until(() => fake.managedOpens.length >= 1));
      fake.dockChanges!.publish({
        type: "failed",
        key: { threadId: thread.threadId, tabId: opened.tabId },
        reason: "no-window",
      });
      yield* Effect.promise(() => fake.until(() => fake.builtinOpens >= 1));

      yield* manualOpen;
      yield* Effect.promise(() =>
        fake.until(() => fake.managedOpens.length >= 2 || fake.builtinOpens >= 2),
      );
      expect(fake.managedOpens).toHaveLength(2);
      expect(fake.builtinOpens).toBe(1);
    }),
  ).pipe(Effect.provide(layer)),
);

it.effect("a concurrent open cannot consume another tab's Firefox fallback", () =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* ServerBrowser.ServerBrowser;
      const report = yield* reportMode("firefox-docked");
      yield* report();
      yield* awaitReady;
      fake.failOpens = 1;
      fake.interleaveOpen = true;
      const opened = yield* manualOpen;
      yield* Effect.promise(() => fake.until(() => fake.builtinOpens >= 1));
      yield* Effect.promise(() => fake.until(() => fake.managedOpens.length >= 2));
      expect(fake.managedOpens).toEqual([opened.tabId, fake.concurrentTab]);
      expect(fake.builtinOpens).toBe(1);
    }),
  ).pipe(Effect.provide(layer)),
);
