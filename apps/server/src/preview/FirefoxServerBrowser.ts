import {
  PREVIEW_AUTOMATION_SERVER_OPERATIONS,
  PreviewClearProfileError,
  SERVER_BROWSER_AUTOMATION_CLIENT_ID,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as Broker from "../mcp/PreviewAutomationBroker.ts";
import { FirefoxBrowser } from "./FirefoxBrowser.ts";
import * as FirefoxProcess from "./FirefoxProcess.ts";
import * as MarionetteClient from "./MarionetteClient.ts";
import * as GuardedBrowserClick from "./GuardedBrowserClick.ts";
import { firefoxBidiPort } from "./FirefoxBidiEndpoint.ts";
import type { ServerBrowser } from "./ServerBrowser.ts";
import { ServerBrowserLaunchError } from "./ServerBrowser.ts";
import { toOperationError } from "./ServerBrowserPage.ts";

export const makeBrowser = Effect.fn("FirefoxServerBrowser.makeBrowser")(function* (
  options: FirefoxBrowser["options"] = {},
) {
  const env = yield* HostProcess.Environment;
  const platform = yield* HostProcess.Platform;
  const client = yield* MarionetteClient.MarionetteClient;
  const bidiPort = firefoxBidiPort(env.T3CODE_FIREFOX_BIDI_PORT);
  const guarded = yield* GuardedBrowserClick.GuardedBrowserClick;
  const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());
  const configuredPort = Number(env.T3CODE_FIREFOX_PORT ?? 2828);
  if (!Number.isInteger(configuredPort) || configuredPort < 1 || configuredPort > 65535)
    return yield* Effect.die(new Error("T3CODE_FIREFOX_PORT must be an integer from 1 to 65535."));
  const mode = env.T3CODE_FIREFOX_MODE ?? "attach";
  if (mode !== "attach" && mode !== "launch")
    return yield* Effect.die(new Error("T3CODE_FIREFOX_MODE must be attach or launch."));
  const process =
    mode === "launch"
      ? yield* FirefoxProcess.launch({
          executable:
            env.T3CODE_FIREFOX_BINARY ??
            (platform === "darwin"
              ? "/Applications/Firefox.app/Contents/MacOS/firefox"
              : "firefox"),
          ...(env.T3CODE_FIREFOX_PORT === undefined ? {} : { port: configuredPort }),
          headless: env.T3CODE_FIREFOX_HEADLESS !== "0",
          ...(bidiPort === undefined ? {} : { bidiPort }),
        })
      : undefined;
  const connection = yield* client.connection({ port: process?.port ?? configuredPort });
  const browser = yield* Effect.acquireRelease(
    Effect.sync(
      () =>
        new FirefoxBrowser(connection, {
          ...options,
          ...(bidiPort === undefined ? {} : { bidiPort }),
          autofill: {
            supported: guarded.supported,
            click: (pid, target) => runPromise(guarded.click(pid, target)),
          },
        }),
    ),
    (browser) => Effect.promise(() => browser.close()),
  );
  return browser;
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
          cause: new Error(
            "The attached Firefox profile belongs to its owner and cannot be cleared by T3.",
          ),
        }),
      ),
    profileReporter: Effect.succeed(() => Effect.void),
  } satisfies ServerBrowser["Service"];
}).pipe(Effect.provide(GuardedBrowserClick.layer));
