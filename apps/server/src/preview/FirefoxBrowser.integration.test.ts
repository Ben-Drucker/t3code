// @effect-diagnostics nodeBuiltinImport:off -- Fixtures own local servers, temporary files, and isolated browser processes.
import { expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { chromium } from "playwright-core";
import {
  ThreadId,
  EnvironmentId,
  ProviderInstanceId,
  PreviewTabId,
  PreviewAutomationSnapshot,
  PreviewAutomationStatus,
  type PreviewAutomationOperation,
  type PreviewAutomationRequest,
} from "@t3tools/contracts";
import { FirefoxBrowser } from "./FirefoxBrowser.ts";
import * as MarionetteClient from "./MarionetteClient.ts";
import * as FirefoxProcess from "./FirefoxProcess.ts";
import * as FirefoxServerBrowser from "./FirefoxServerBrowser.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as Broker from "../mcp/PreviewAutomationBroker.ts";
import * as ServerBrowserPage from "./ServerBrowserPage.ts";

const decodeStatus = Schema.decodeUnknownSync(PreviewAutomationStatus);
const decodeSnapshot = Schema.decodeUnknownSync(PreviewAutomationSnapshot);
// oxlint-disable-next-line t3code/no-global-process-runtime -- Installed-browser discovery must use the actual host before registering conditional tests.
const testPlatform = NodeOS.platform();
const executable =
  process.env.T3CODE_FIREFOX_TEST_BINARY ??
  (testPlatform === "darwin"
    ? "/Applications/Firefox.app/Contents/MacOS/firefox"
    : ["/usr/bin/firefox", "/usr/bin/firefox-esr"].find((path) => NodeFS.existsSync(path)));
const firefoxTest = it.live.runIf(executable !== undefined && NodeFS.existsSync(executable));
const chrome =
  process.env.T3CODE_CHROME_TEST_BINARY ??
  (testPlatform === "darwin"
    ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    : chromium.executablePath());
const fixtureHtml = `<!doctype html><meta charset="utf-8"><title>Firefox fixture</title>
<style>#scroller {width:200px;height:80px;overflow:auto} #scroller div {height:600px} #hover:hover {color:rgb(255,0,0)} #source,#destination {display:inline-block;width:60px;height:40px} iframe {height:100px}</style>
<label>Name <input id="name"></label><input id="readonly" readonly><button id="send">Send</button><p id="result"></p>
<label><input id="check" type="checkbox">Enabled</label>
<select id="choice"><option value="a">Alpha</option><option value="b">Beta</option></select>
<select id="multi" multiple><option value="a">Alpha</option><option value="b">Beta</option></select>
<input id="file" type="file" multiple><input id="secret" type="password" value="never-expose-this">
<button id="alert">Alert</button><button id="confirm">Confirm</button><button id="prompt">Prompt</button>
<button id="dynamic">Add later</button><div id="hover">Hover here</div><div id="source">Drag me</div><div id="destination">Drop here</div>
<div id="shadow"></div><iframe title="Frame" src="/frame"></iframe><iframe title="Cross origin" src="http://localhost:PORT/frame"></iframe>
<div id="scroller"><div>Scrollable</div></div><div style="height:1500px">Long page</div>
<script>window.events=[];
for (const event of ['click','keydown','input','pointerover','pointerdown','pointerup','wheel']) document.addEventListener(event, e=>window.events.push({type:e.type,id:e.target.id,trusted:e.isTrusted}));
document.querySelector('#send').onclick=()=>document.querySelector('#result').textContent=document.querySelector('#name').value;
document.querySelector('#alert').onclick=()=>alert('Alert message');
document.querySelector('#confirm').onclick=()=>document.querySelector('#result').textContent=String(confirm('Confirm message'));
document.querySelector('#prompt').onclick=()=>document.querySelector('#result').textContent=String(prompt('Prompt message','Original'));
document.querySelector('#dynamic').onclick=()=>Promise.resolve().then(()=>{const button=document.createElement('button');button.id='later';button.textContent='Arrived';document.body.append(button)});
document.querySelector('#shadow').attachShadow({mode:'open'}).innerHTML='<label>Shadow name <input id="shadow-name"></label><button id="shadow-button">Shadow send</button>';
</script>`;

const harness = async () => {
  let origin = "";
  const server = NodeHttp.createServer((request, response) => {
    response.setHeader("Content-Type", "text/html");
    response.end(
      request.url?.startsWith("/frame")
        ? '<!doctype html><label>Frame name <input id="frame-name"></label><button>Frame send</button>'
        : fixtureHtml.replace("PORT", new URL(origin).port),
    );
  });
  server.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  origin = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-firefox-fixture-"));
  return {
    origin,
    directory,
    async [Symbol.asyncDispose]() {
      server.closeAllConnections();
      server.close();
      await new Promise<void>((resolve) => server.once("close", resolve));
      await NodeFSP.rm(directory, { recursive: true, force: true });
    },
  };
};
type Harness = Awaited<ReturnType<typeof harness>>;

const withBrowser = (
  run: (context: {
    browser: FirefoxBrowser;
    connection: MarionetteClient.MarionetteConnection;
    invoke: (
      operation: PreviewAutomationOperation,
      input?: unknown,
      overrides?: Partial<PreviewAutomationRequest>,
    ) => Promise<unknown>;
    evaluate: (expression: string) => Promise<unknown>;
    fixture: Harness;
    tabId: string;
  }) => Promise<void>,
  options: { bidi?: boolean } = {},
) =>
  Effect.gen(function* () {
    const fixture = yield* Effect.acquireDisposable(Effect.promise(harness));
    const running = yield* FirefoxProcess.launch({ executable: executable!, ...options });
    yield* Effect.promise(async () => {
      const connection = new MarionetteClient.MarionetteConnection({ port: running.port });
      const browser = new FirefoxBrowser(connection);
      let tabId: string | undefined;
      const invoke = (
        operation: PreviewAutomationOperation,
        input: unknown = {},
        overrides: Partial<PreviewAutomationRequest> = {},
      ) =>
        browser.execute({
          requestId: "test",
          threadId: ThreadId.make("test-thread"),
          agentSessionId: "agent",
          operation,
          input,
          timeoutMs: 5000,
          ...(tabId ? { tabId: PreviewTabId.make(tabId), tabIdExplicit: true } : {}),
          ...overrides,
        });
      try {
        const opened = decodeStatus(await invoke("open", { url: fixture.origin }));
        tabId = opened.tabId!;
        expect(opened.title).toBe("Firefox fixture");
        await run({
          browser,
          connection,
          invoke,
          evaluate: (expression) => invoke("evaluate", { expression }),
          fixture,
          tabId,
        });
      } finally {
        await browser.close();
        await connection.close();
      }
    });
  });

firefoxTest("uses native form input, keys, hover, select, wheel, drag, and uploads", () =>
  withBrowser(async ({ invoke, evaluate, fixture }) => {
    await invoke("type", { selector: "#name", text: "Ada 🦊", clear: true });
    await invoke("press", { key: "End" });
    await invoke("press", { key: "Backspace" });
    await invoke("type", { text: "Lovelace" });
    await invoke("click", { locator: 'role=button[name="Send"]' });
    expect(await evaluate("document.querySelector('#result').textContent")).toBe("Ada Lovelace");
    await invoke("click", { selector: "#check" });
    expect(await evaluate("document.querySelector('#check').checked")).toBe(true);
    await expect(invoke("type", { selector: "#readonly", text: "wrong" })).rejects.toMatchObject({
      tag: "PreviewAutomationTargetNotEditableError",
    });
    expect(await invoke("select", { selector: "#choice", values: ["Beta"] })).toEqual({
      selected: ["b"],
    });
    expect(await invoke("select", { selector: "#multi", values: ["a", "b"] })).toEqual({
      selected: ["a", "b"],
    });
    expect(await invoke("select", { selector: "#multi", values: [] })).toEqual({ selected: [] });
    await invoke("hover", { selector: "#hover" });
    expect(await evaluate("getComputedStyle(document.querySelector('#hover')).color")).toBe(
      "rgb(255, 0, 0)",
    );
    await invoke("scroll", { selector: "#scroller", deltaY: 120 });
    expect(await evaluate("document.querySelector('#scroller').scrollTop")).toBeGreaterThan(0);
    await invoke("drag", { source: "#source", target: "#destination" });
    const file = NodePath.join(fixture.directory, "upload.txt");
    await NodeFSP.writeFile(file, "fixture upload");
    await invoke("upload", { selector: "#file", paths: [file] });
    expect(await evaluate("document.querySelector('#file').files[0].name")).toBe("upload.txt");
    await invoke("upload", { selector: "#file", paths: [] });
    expect(await evaluate("document.querySelector('#file').files.length")).toBe(0);
    await expect(invoke("upload", { paths: [file] })).rejects.toMatchObject({
      tag: "PreviewAutomationUnsupportedClientError",
    });
    await expect(
      invoke("upload", { selector: "#file", paths: ["relative.txt"] }),
    ).rejects.toMatchObject({ tag: "PreviewAutomationExecutionError" });
    const events = (await evaluate("window.events")) as Array<{
      type: string;
      id: string;
      trusted: boolean;
    }>;
    expect(
      events.some((event) => event.type === "click" && event.id === "send" && event.trusted),
    ).toBe(true);
    expect(
      events.some((event) => event.type === "input" && event.id === "name" && event.trusted),
    ).toBe(true);
    expect(
      events.some(
        (event) => event.type === "pointerup" && event.id === "destination" && event.trusted,
      ),
    ).toBe(true);
  }),
);

firefoxTest(
  "captures frames and shadow refs, revokes stale refs, and compares with Playwright",
  () =>
    withBrowser(async ({ invoke, evaluate, fixture }) => {
      const snapshot = decodeSnapshot(await invoke("snapshot"));
      expect(snapshot.visibleText).toContain("Frame name");
      expect(snapshot.accessibilityTree).toContain('button "Shadow send"');
      expect(JSON.stringify(snapshot)).not.toContain("never-expose-this");
      expect(Buffer.from(snapshot.screenshot.data, "base64").subarray(1, 4).toString()).toBe("PNG");
      const shadow = snapshot.interactiveElements.find(
        (element) => element.name === "Shadow name",
      )!;
      await invoke("type", { locator: shadow.selector, text: "Shadow" });
      await invoke("type", { text: " focused" });
      expect(
        await evaluate("document.querySelector('#shadow').shadowRoot.querySelector('input').value"),
      ).toBe("Shadow focused");
      const frames = snapshot.interactiveElements.filter(
        (element) => element.name === "Frame name",
      );
      expect(frames).toHaveLength(2);
      await invoke("type", { locator: frames[0]!.selector, text: "Frame" });
      await invoke("type", { text: " focused" });
      expect(
        await evaluate(
          "document.querySelector('iframe').contentDocument.querySelector('input').value",
        ),
      ).toBe("Frame focused");
      await invoke("type", { locator: frames[1]!.selector, text: "Cross origin" });
      await invoke("snapshot");
      await expect(invoke("click", { locator: shadow.selector })).rejects.toMatchObject({
        tag: "PreviewAutomationInvalidSelectorError",
      });
      await expect(invoke("click", { selector: "button" })).rejects.toMatchObject({
        tag: "PreviewAutomationInvalidSelectorError",
      });
      if (NodeFS.existsSync(chrome)) {
        const browser = await chromium.launch({ executablePath: chrome, headless: true });
        try {
          const page = await browser.newPage();
          await page.goto(fixture.origin);
          const cdp = await page.context().newCDPSession(page);
          const reference = await ServerBrowserPage.snapshot({
            renderScale: 1,
            page,
            cdp,
            consoleEntries: [],
            networkEntries: [],
            actionTimeline: [],
          });
          expect(reference.visibleText).toContain("Send");
          expect(snapshot.visibleText).toContain("Send");
          expect(String(reference.accessibilityTree)).toContain('button "Send"');
          expect(String(snapshot.accessibilityTree)).toContain('button "Send"');
        } finally {
          await browser.close();
        }
      }
    }),
);

firefoxTest("resolves alerts, confirms, and prompts without blocking its queue", () =>
  withBrowser(async ({ invoke, evaluate }) => {
    await invoke("click", { selector: "#alert" });
    const alert = decodeStatus(await invoke("status"));
    expect(alert.dialog?.message).toBe("Alert message");
    await invoke("dialog", { accept: true });
    await invoke("click", { selector: "#confirm" });
    await invoke("dialog", { accept: false });
    expect(await evaluate("document.querySelector('#result').textContent")).toBe("false");
    await invoke("click", { selector: "#prompt" });
    const prompt = decodeStatus(await invoke("status"));
    expect(prompt.dialog).toMatchObject({ type: "prompt", defaultValue: "Original" });
    await invoke("dialog", { accept: true, promptText: "Answer" });
    expect(await evaluate("document.querySelector('#result').textContent")).toBe("Answer");
  }),
);

firefoxTest("waits, evaluates promises, bounds results, resizes, and resets appearance", () =>
  withBrowser(async ({ invoke, evaluate }) => {
    await invoke("click", { selector: "#dynamic" });
    await invoke("waitFor", { selector: "#later", text: "Arrived", urlIncludes: "127.0.0.1" });
    await expect(invoke("waitFor", { selector: "#missing", timeoutMs: 100 })).rejects.toMatchObject(
      { tag: "PreviewAutomationTimeoutError" },
    );
    expect(await evaluate("Promise.resolve({answer:42})")).toEqual({ answer: 42 });
    await expect(evaluate("(()=>{throw new Error('fixture')})()")).rejects.toMatchObject({
      tag: "PreviewAutomationExecutionError",
    });
    await expect(evaluate("'x'.repeat(65000)")).rejects.toMatchObject({
      tag: "PreviewAutomationResultTooLargeError",
    });
    await expect(
      invoke("evaluate", { expression: "new Promise(()=>{})" }, { timeoutMs: 100 }),
    ).rejects.toMatchObject({ tag: "PreviewAutomationTimeoutError" });
    expect(await evaluate("6*7")).toBe(42);
    const resize = await invoke("resize", { mode: "freeform", width: 1000, height: 700 });
    expect(resize).toMatchObject({
      viewport: { width: 1000, height: 700 },
    });
    await invoke("setColorScheme", { colorScheme: "dark" });
    expect(await evaluate("matchMedia('(prefers-color-scheme: dark)').matches")).toBe(true);
    await invoke("setColorScheme", { colorScheme: "light" });
    expect(await evaluate("matchMedia('(prefers-color-scheme: light)').matches")).toBe(true);
    await invoke("setColorScheme", { colorScheme: "system" });
    await expect(invoke("recordingStart")).rejects.toMatchObject({
      tag: "PreviewAutomationUnsupportedClientError",
    });
    await expect(invoke("recordingStop")).rejects.toMatchObject({
      tag: "PreviewAutomationUnsupportedClientError",
    });
  }),
);

firefoxTest("enforces ownership and closes only tabs opened by this backend", () =>
  withBrowser(async ({ invoke, connection, browser, fixture, tabId }) => {
    await expect(
      invoke("click", { selector: "#send" }, { agentSessionId: "another-agent" }),
    ).rejects.toMatchObject({ tag: "PreviewAutomationControlInterruptedError" });
    const observer = decodeStatus(await invoke("status", {}, { agentSessionId: "another-agent" }));
    expect(observer.control?.ownedByCaller).toBe(false);
    await expect(
      invoke("click", { selector: "#send" }, { threadId: ThreadId.make("other-thread") }),
    ).rejects.toMatchObject({ tag: "PreviewAutomationTabNotFoundError" });
    await expect(invoke("open", { profileId: "incognito" })).rejects.toMatchObject({
      tag: "PreviewAutomationUnsupportedClientError",
    });
    const created = (await connection.command("WebDriver:NewWindow", {
      type: "tab",
      focus: false,
    })) as { handle: string };
    const other = decodeStatus(
      await invoke(
        "open",
        { reuseExistingTab: false, url: fixture.origin },
        { tabId: undefined, tabIdExplicit: false },
      ),
    );
    expect(other.tabs).toHaveLength(2);
    await invoke("open", { url: fixture.origin + "/reused" });
    expect(decodeStatus(await invoke("status")).url).toBe(fixture.origin + "/reused");
    expect(
      decodeStatus(await invoke("status", {}, { tabId: PreviewTabId.make(other.tabId!) })).url,
    ).toBe(fixture.origin + "/");
    await expect(
      invoke("click", { selector: "#send" }, { tabId: undefined, tabIdExplicit: false }),
    ).rejects.toMatchObject({ tag: "PreviewAutomationControlInterruptedError" });
    await invoke("close", {}, { tabId: PreviewTabId.make(tabId) });
    await browser.close();
    const handles = (await connection.command("WebDriver:GetWindowHandles")) as string[];
    expect(handles).toHaveLength(2);
    expect(handles).toContain(created.handle);
  }),
);

firefoxTest("navigates, goes back and forward, reloads, and handles navigation readiness", () =>
  withBrowser(async ({ invoke, evaluate, browser, fixture, tabId }) => {
    const first = decodeSnapshot(await invoke("snapshot"));
    await invoke("navigate", { url: fixture.origin + "/second" });
    expect(await evaluate("location.pathname")).toBe("/second");
    await expect(
      invoke("click", { locator: first.interactiveElements[0]!.selector }),
    ).rejects.toMatchObject({ tag: "PreviewAutomationInvalidSelectorError" });
    await browser.history({ threadId: "test-thread", tabId, direction: "back" });
    expect(await evaluate("location.pathname")).toBe("/");
    await browser.history({ threadId: "test-thread", tabId, direction: "forward" });
    expect(await evaluate("location.pathname")).toBe("/second");
    await evaluate("window.reloadMarker=true");
    await browser.history({ threadId: "test-thread", tabId, direction: "reload" });
    expect(await evaluate("window.reloadMarker ?? null")).toBe(null);
    await browser
      .history({
        threadId: "test-thread",
        tabId,
        direction: "reload",
        ignoreCache: true,
      })
      .catch((cause) =>
        expect(cause).toMatchObject({ tag: "PreviewAutomationUnsupportedClientError" }),
      );
    await invoke("navigate", { url: fixture.origin + "/eager", readiness: "domContentLoaded" });
    expect(await evaluate("location.pathname")).toBe("/eager");
    await invoke("navigate", { url: fixture.origin + "/none", readiness: "none" });
    await invoke("waitFor", { urlIncludes: "/none" });
    expect(await evaluate("location.pathname")).toBe("/none");
  }),
);

firefoxTest(
  "attaches through Marionette alone and reports the capabilities that require BiDi",
  () =>
    withBrowser(
      async ({ invoke, evaluate, connection }) => {
        expect(connection.webSocketUrl).toBeUndefined();
        await invoke("click", { selector: "#alert" });
        const status = decodeStatus(await invoke("status"));
        expect(status.dialog).toMatchObject({ type: "dialog", message: "Alert message" });
        await invoke("dialog", { accept: true });
        expect(await evaluate("document.title")).toBe("Firefox fixture");
        await expect(invoke("setColorScheme", { colorScheme: "dark" })).rejects.toMatchObject({
          tag: "PreviewAutomationUnsupportedClientError",
        });
        await expect(
          invoke("navigate", { url: "http://localhost", readiness: "none" }),
        ).rejects.toMatchObject({ tag: "PreviewAutomationUnsupportedClientError" });
      },
      { bidi: false },
    ),
);

firefoxTest(
  "serves preview tools through the authorized broker and preserves error envelopes",
  () => {
    const environmentId = EnvironmentId.make("firefox-integration");
    return Effect.gen(function* () {
      const fixture = yield* Effect.acquireDisposable(Effect.promise(harness));
      const running = yield* FirefoxProcess.launch({ executable: executable! });
      const broker = yield* Broker.PreviewAutomationBroker;
      const connected = yield* Deferred.make<void>();
      yield* FirefoxServerBrowser.make.pipe(
        Effect.provideService(HostProcess.Environment, {
          T3CODE_FIREFOX_PORT: String(running.port),
        }),
        Effect.provideService(Broker.PreviewAutomationBroker, {
          ...broker,
          focusHost: (host) =>
            broker.focusHost(host).pipe(Effect.tap(() => Deferred.succeed(connected, undefined))),
        }),
      );
      yield* Deferred.await(connected);
      const scope = {
        environmentId,
        thread: {
          threadId: ThreadId.make("broker-test"),
          providerSessionId: "agent",
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
        client: undefined,
        requestNamespace: "firefox-test",
        capabilities: new Set(["preview"] as const),
        issuedAt: 1,
      };
      const opened = yield* broker.invoke<PreviewAutomationStatus>({
        scope,
        operation: "open",
        input: { url: fixture.origin, open: false },
      });
      expect(opened).toMatchObject({
        available: true,
        title: "Firefox fixture",
        control: { ownedByCaller: true },
      });
      const snapshot = yield* broker.invoke<PreviewAutomationSnapshot>({
        scope,
        operation: "snapshot",
        input: {},
      });
      expect(decodeSnapshot(snapshot).accessibilityTree).toContain('button "Send"');
      const unsupported = yield* broker
        .invoke<{ recording: boolean }>({ scope, operation: "recordingStart", input: {} })
        .pipe(Effect.flip);
      expect(unsupported._tag).toBe("PreviewAutomationUnsupportedClientError");
      yield* broker.invoke({ scope, operation: "close", input: {} });
      expect(yield* broker.invoke({ scope, operation: "status", input: {} })).toMatchObject({
        available: false,
        tabId: null,
      });
    }).pipe(
      Effect.provide(
        Layer.mergeAll(Broker.layer, MarionetteClient.layer).pipe(Layer.provide(NodeCrypto.layer)),
      ),
      Effect.provideService(ServerEnvironment.ServerEnvironment, {
        getEnvironmentId: Effect.succeed(environmentId),
        getDescriptor: Effect.die("unused fixture descriptor"),
      }),
    );
  },
);
