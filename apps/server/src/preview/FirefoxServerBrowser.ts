// @effect-diagnostics nodeBuiltinImport:off -- Resolves T3's dedicated Firefox profile directory on disk.
import {
  PREVIEW_AUTOMATION_SERVER_OPERATIONS,
  PreviewClearProfileError,
  type PreviewAutomationRequest,
  type PreviewSessionSnapshot,
  SERVER_BROWSER_AUTOMATION_CLIENT_ID,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as NodePath from "node:path";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as Broker from "../mcp/PreviewAutomationBroker.ts";
import { FirefoxBrowser } from "./FirefoxBrowser.ts";
import { firefoxBidiPort } from "./FirefoxBidiEndpoint.ts";
import * as FirefoxProcess from "./FirefoxProcess.ts";
import { MarionetteClient, MarionetteConnection } from "./MarionetteClient.ts";
import type { ServerBrowser } from "./ServerBrowser.ts";
import { ServerBrowserLaunchError } from "./ServerBrowser.ts";
import type { ServerBrowserBackend, ServerBrowserHistoryInput } from "./ServerBrowserBackend.ts";
import { toOperationError } from "./ServerBrowserPage.ts";

export interface ManagedFirefoxBrowser extends ServerBrowserBackend {
  readonly liveTabs: FirefoxBrowser["liveTabs"];
  readonly openManaged: (
    snapshot: PreviewSessionSnapshot,
  ) => ReturnType<FirefoxBrowser["openManaged"]>;
  readonly closeTab: (tabId: string) => Promise<void>;
}

export type FirefoxLaunchPlan =
  | {
      readonly kind: "lazy-isolated";
      readonly executable: string;
      readonly profileDir: string | undefined;
      readonly bidiPort: number | undefined;
      readonly allowSystemAccess: boolean;
    }
  | {
      readonly kind: "eager-launch";
      readonly executable: string;
      readonly port: number | undefined;
      readonly headless: boolean;
      readonly bidiPort: number | undefined;
      readonly allowSystemAccess: boolean;
    }
  | {
      readonly kind: "attach";
      readonly port: number;
      readonly bidiPort: number | undefined;
      /** Docking requires a uniquely marked, T3-created window. */
      readonly allowDocking: boolean;
    };

const resolveFirefoxExecutable = (
  env: Record<string, string | undefined>,
  platform: string,
): string =>
  env.T3CODE_FIREFOX_BINARY ??
  (platform === "darwin" ? "/Applications/Firefox.app/Contents/MacOS/firefox" : "firefox");

export const resolveFirefoxLaunchPlan = (input: {
  readonly env: Record<string, string | undefined>;
  readonly platform: string;
  readonly profilesDir?: string | undefined;
}): FirefoxLaunchPlan => {
  const { env, platform, profilesDir } = input;
  const bidiPort = firefoxBidiPort(env.T3CODE_FIREFOX_BIDI_PORT);
  const configuredPort = Number(env.T3CODE_FIREFOX_PORT ?? 2828);
  if (!Number.isInteger(configuredPort) || configuredPort < 1 || configuredPort > 65535) {
    throw new Error("T3CODE_FIREFOX_PORT must be an integer from 1 to 65535.");
  }
  const rawMode = env.T3CODE_FIREFOX_MODE;
  if (rawMode !== undefined && !["attach", "launch", "isolated"].includes(rawMode)) {
    throw new Error("T3CODE_FIREFOX_MODE must be attach, launch, or isolated.");
  }
  const executable = resolveFirefoxExecutable(env, platform);
  if (rawMode === "launch") {
    return {
      kind: "eager-launch",
      executable,
      port: env.T3CODE_FIREFOX_PORT === undefined ? undefined : configuredPort,
      headless: env.T3CODE_FIREFOX_HEADLESS !== "0",
      bidiPort,
      allowSystemAccess: platform === "darwin",
    };
  }
  if (rawMode !== "isolated") {
    return {
      kind: "attach",
      port: configuredPort,
      bidiPort,
      allowDocking: true,
    };
  }
  return {
    kind: "lazy-isolated",
    executable,
    profileDir:
      profilesDir === undefined
        ? undefined
        : NodePath.join(profilesDir, FirefoxProcess.DOCKED_FIREFOX_PROFILE_NAME),
    bidiPort,
    allowSystemAccess: platform === "darwin",
  };
};

class LazyIsolatedFirefoxBrowser implements ManagedFirefoxBrowser {
  private session:
    | Promise<{
        readonly running: FirefoxProcess.StartedFirefoxProcess;
        readonly connection: MarionetteConnection;
        readonly browser: FirefoxBrowser;
      }>
    | undefined;
  private activeBrowser: FirefoxBrowser | undefined;
  private closed = false;

  private readonly plan: Extract<FirefoxLaunchPlan, { readonly kind: "lazy-isolated" }>;
  private readonly options: FirefoxBrowser["options"];
  private readonly platform: string;

  constructor(
    plan: Extract<FirefoxLaunchPlan, { readonly kind: "lazy-isolated" }>,
    options: FirefoxBrowser["options"],
    platform: string,
  ) {
    this.plan = plan;
    this.options = options;
    this.platform = platform;
  }

  get liveTabs() {
    return this.activeBrowser?.liveTabs ?? [];
  }

  private ensureSession() {
    if (this.closed) return Promise.reject(new Error("The Firefox preview is closed."));
    if (this.session) return this.session;
    const starting = (async () => {
      const headless =
        this.options.docked?.() === true ? false : process.env.T3CODE_FIREFOX_HEADLESS === "1";
      const running = await FirefoxProcess.start({
        executable: this.plan.executable,
        ...(this.plan.profileDir === undefined ? {} : { profileDir: this.plan.profileDir }),
        headless,
        ...(this.plan.bidiPort === undefined ? {} : { bidiPort: this.plan.bidiPort }),
        allowSystemAccess: this.plan.allowSystemAccess,
      });
      const connection = new MarionetteConnection({ port: running.port });
      const browser = new FirefoxBrowser(connection, {
        ...this.options,
        ownedProcessId: running.pid,
        reuseInitialWindow: !headless,
        ...(this.plan.bidiPort === undefined ? {} : { bidiPort: this.plan.bidiPort }),
        autofill: { supported: this.platform === "darwin" },
      });
      this.activeBrowser = browser;
      void running.exited.then(() => {
        if (this.session === starting) {
          this.session = undefined;
          this.activeBrowser = undefined;
          void connection.close().catch(() => undefined);
        }
      });
      return { running, connection, browser };
    })();
    this.session = starting;
    void starting.catch(() => {
      if (this.session === starting) {
        this.session = undefined;
        this.activeBrowser = undefined;
      }
    });
    return starting;
  }

  async execute(request: PreviewAutomationRequest): Promise<unknown> {
    if (request.operation === "status" && !this.session) {
      return {
        available: false,
        visible: false,
        tabId: null,
        url: null,
        title: null,
        loading: false,
        backend: "firefox" as const,
        capabilityMessage: "Firefox (docked) launches an isolated Firefox profile on first open.",
        profiles: [{ id: "firefox", name: "Firefox" }],
        defaultProfileId: "firefox",
        tabs: [],
      };
    }
    const { browser } = await this.ensureSession();
    return browser.execute(request);
  }

  async openManaged(snapshot: PreviewSessionSnapshot) {
    const { browser } = await this.ensureSession();
    return browser.openManaged(snapshot);
  }

  async closeTab(tabId: string) {
    const current = await this.session?.catch(() => undefined);
    if (!current) return;
    await current.browser.closeTab(tabId);
  }

  async history(input: ServerBrowserHistoryInput) {
    const current = await this.session?.catch(() => undefined);
    if (!current) throw new Error("This Firefox preview tab does not exist.");
    return current.browser.history(input);
  }

  async close() {
    this.closed = true;
    const pending = this.session;
    this.session = undefined;
    this.activeBrowser = undefined;
    const current = await pending?.catch(() => undefined);
    if (!current) return;
    await current.browser.close().catch(() => undefined);
    await current.connection.close().catch(() => undefined);
    await current.running.stop().catch(() => undefined);
  }
}

export const makeBrowser = Effect.fn("FirefoxServerBrowser.makeBrowser")(function* (
  options: FirefoxBrowser["options"] & { readonly profilesDir?: string | undefined } = {},
) {
  const env = yield* HostProcess.Environment;
  const platform = yield* HostProcess.Platform;
  const client = yield* MarionetteClient;
  const { profilesDir, ...browserOptions } = options;
  const plan = yield* Effect.try({
    try: () => resolveFirefoxLaunchPlan({ env, platform, profilesDir }),
    catch: (cause) => new ServerBrowserLaunchError({ cause }),
  }).pipe(Effect.orDie);

  if (plan.kind === "lazy-isolated") {
    return yield* Effect.acquireRelease(
      Effect.sync(
        (): ManagedFirefoxBrowser => new LazyIsolatedFirefoxBrowser(plan, browserOptions, platform),
      ),
      (browser) => Effect.promise(() => browser.close()),
    );
  }

  if (plan.kind === "eager-launch") {
    const running = yield* FirefoxProcess.launch({
      executable: plan.executable,
      ...(plan.port === undefined ? {} : { port: plan.port }),
      headless: plan.headless,
      ...(plan.bidiPort === undefined ? {} : { bidiPort: plan.bidiPort }),
      allowSystemAccess: plan.allowSystemAccess,
    });
    const connection = yield* client.connection({ port: running.port });
    return yield* Effect.acquireRelease(
      Effect.sync(
        () =>
          new FirefoxBrowser(connection, {
            ...browserOptions,
            ownedProcessId: running.pid,
            reuseInitialWindow: !plan.headless,
            ...(plan.bidiPort === undefined ? {} : { bidiPort: plan.bidiPort }),
            autofill: { supported: platform === "darwin" },
          }),
      ),
      (browser) => Effect.promise(() => browser.close()),
    );
  }

  const connection = yield* client.connection({ port: plan.port });
  const browser = new FirefoxBrowser(connection, {
    ...browserOptions,
    ...(plan.bidiPort === undefined ? {} : { bidiPort: plan.bidiPort }),
    autofill: { supported: platform === "darwin" },
    get ownedProcessId() {
      return connection.processId;
    },
  });
  return yield* Effect.acquireRelease(Effect.succeed(browser), (instance) =>
    Effect.promise(() => instance.close()),
  );
});

export const make = Effect.gen(function* () {
  const browser = yield* makeBrowser();
  const broker = yield* Broker.PreviewAutomationBroker;
  const environmentId = yield* (yield* ServerEnvironment.ServerEnvironment).getEnvironmentId;
  const reportTabs = (connectionId: string) =>
    broker.focusHost({
      clientId: SERVER_BROWSER_AUTOMATION_CLIENT_ID,
      environmentId,
      connectionId,
      focused: false,
      liveTabs: browser.liveTabs.map((tab) => ({
        ...tab,
        threadId: tab.threadId as import("@t3tools/contracts").ThreadId,
      })),
    });
  const host = broker
    .connect(
      {
        clientId: SERVER_BROWSER_AUTOMATION_CLIENT_ID,
        environmentId,
        supportedOperations: [...PREVIEW_AUTOMATION_SERVER_OPERATIONS],
      },
      { preferred: true },
    )
    .pipe(
      Effect.flatMap((events) =>
        Stream.runForEach(events, (event) => {
          if (event.type === "connected") return reportTabs(event.connectionId);
          return Effect.tryPromise({
            try: () => browser.execute(event.request),
            catch: toOperationError,
          }).pipe(
            Effect.match({
              onSuccess: (result) => ({ ok: true as const, result }),
              onFailure: (error) => ({
                ok: false as const,
                error: {
                  _tag: error.tag,
                  message: error.message,
                  ...(error.detail === undefined ? {} : { detail: error.detail }),
                },
              }),
            }),
            Effect.flatMap((outcome) =>
              broker.respond({
                clientId: SERVER_BROWSER_AUTOMATION_CLIENT_ID,
                connectionId: event.connectionId,
                requestId: event.request.requestId,
                ...outcome,
              }),
            ),
            Effect.andThen(reportTabs(event.connectionId)),
            Effect.ignore,
            Effect.forkScoped,
            Effect.asVoid,
          );
        }),
      ),
    );
  yield* host.pipe(
    Effect.exit,
    Effect.andThen(Effect.sleep("1 second")),
    Effect.forever,
    Effect.forkScoped,
  );
  return {
    attachViewer: () =>
      Effect.fail(
        new ServerBrowserLaunchError({
          cause: new Error(
            "Firefox preview streaming is unavailable; use preview_snapshot or Firefox's own window.",
          ),
        }),
      ),
    answerFileChooser: () => Effect.succeed(false),
    openDownload: () => Effect.succeedNone,
    clearProfile: (profileId) =>
      Effect.fail(
        new PreviewClearProfileError({
          profileId,
          cause: new Error("The Firefox preview profile cannot be cleared while active."),
        }),
      ),
    profileReporter: Effect.succeed(() => Effect.void),
  } satisfies ServerBrowser["Service"];
});
