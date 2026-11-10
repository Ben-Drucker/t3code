// @effect-diagnostics nodeBuiltinImport:off globalDate:off -- Promise adapter serializes Firefox's process-global current window and frame.
import type {
  PreviewAutomationActionEvent,
  PreviewAutomationClickInput,
  PreviewAutomationConsoleEntry,
  PreviewAutomationDialogInput,
  PreviewAutomationDragInput,
  PreviewAutomationEvaluateInput,
  PreviewAutomationHoverInput,
  PreviewAutomationNavigateInput,
  PreviewAutomationNetworkEntry,
  PreviewAutomationOpenInput,
  PreviewAutomationPressInput,
  PreviewAutomationRequest,
  PreviewAutomationResizeInput,
  PreviewAutomationScrollInput,
  PreviewAutomationSelectInput,
  PreviewAutomationSetColorSchemeInput,
  PreviewAutomationSnapshot,
  PreviewAutomationSnapshotInput,
  PreviewAutomationStatus,
  PreviewAutomationTypeInput,
  PreviewAutomationUploadInput,
  PreviewAutomationWaitForInput,
  PreviewViewportSetting,
} from "@t3tools/contracts";
import { normalizePreviewUrl } from "@t3tools/shared/preview";
import { ThreadId } from "@t3tools/contracts";
import { resolvePreviewViewport } from "@t3tools/shared/previewViewport";
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";
import * as Schema from "effect/Schema";

import { FirefoxBidi } from "./FirefoxBidi.ts";
import { autofillFirefox, type AutofillOptions } from "./FirefoxAutofill.ts";
import { bidiPortStatus } from "./FirefoxBidiEndpoint.ts";
import type { Rect } from "./FirefoxAutofillGeometry.ts";
import * as PageScript from "./FirefoxPageScript.ts";
import { MarionetteConnection, MarionetteError } from "./MarionetteClient.ts";
import { ServerBrowserOperationError, toOperationError } from "./ServerBrowserPage.ts";
import { BrowserControlInterrupted } from "./SessionControl.ts";
import type { ServerBrowserBackend, ServerBrowserHistoryInput } from "./ServerBrowserBackend.ts";

type Element = Record<string, string>;
interface Tab {
  readonly threadId: PreviewAutomationRequest["threadId"];
  readonly tabId: string;
  readonly handle: string;
  readonly owner: string;
  readonly refs: Map<string, ReadonlyArray<Element>>;
  readonly consoleEntries: Array<PreviewAutomationConsoleEntry>;
  readonly networkEntries: Array<PreviewAutomationNetworkEntry>;
  readonly actionTimeline: Array<PreviewAutomationActionEvent>;
  setting: PreviewViewportSetting;
  url: string | null;
  title: string | null;
  viewport: { width: number; height: number };
  dialog: { type: string; message: string; defaultValue: string } | null;
}
interface Collected {
  url: string;
  title: string;
  loading: boolean;
  visibleText: string;
  accessibilityTree: string;
  interactiveElements: PreviewAutomationSnapshot["interactiveElements"];
  frames: Array<Element>;
  width: number;
  height: number;
}

const unsupported = (message: string): never => {
  throw new ServerBrowserOperationError({
    tag: "PreviewAutomationUnsupportedClientError",
    message,
  });
};
const elementId = (element: Element) => element["element-6066-11e4-a52e-4f735466cecf"]!;
const value = <A>(result: unknown): A =>
  (result !== null && typeof result === "object" && "value" in result ? result.value : result) as A;
const bounded = <A>(entries: Array<A>, entry: A, limit = 200) => {
  entries.push(entry);
  if (entries.length > limit) entries.shift();
};
const KEY: Record<string, string> = {
  Enter: "\uE007",
  Tab: "\uE004",
  Escape: "\uE00C",
  Backspace: "\uE003",
  Delete: "\uE017",
  ArrowLeft: "\uE012",
  ArrowUp: "\uE013",
  ArrowRight: "\uE014",
  ArrowDown: "\uE015",
  Home: "\uE011",
  End: "\uE010",
  PageUp: "\uE00E",
  PageDown: "\uE00F",
  Space: " ",
  Shift: "\uE008",
  Control: "\uE009",
  Alt: "\uE00A",
  Meta: "\uE03D",
};
const isMarionetteError = Schema.is(MarionetteError);

export class FirefoxBrowser implements ServerBrowserBackend {
  private readonly tabs = new Map<string, Tab>();
  private queue: Promise<unknown> = Promise.resolve();
  private bidi: FirefoxBidi | undefined;
  private originalHandle: string | undefined;
  private disposed = false;
  private bidiDiagnostic: string | undefined;

  readonly connection: MarionetteConnection;
  readonly options: {
    readonly bidiPort?: number;
    readonly autofill?: AutofillOptions;
    readonly docked?: () => boolean;
    readonly allocateTab?: (request: PreviewAutomationRequest) => Promise<string>;
    readonly opened?: (key: { threadId: string; tabId: string }, pid: number) => Promise<void>;
    readonly closed?: (key: { threadId: string; tabId: string }) => Promise<void>;
    readonly status?: (
      status: PreviewAutomationStatus,
      request: PreviewAutomationRequest,
    ) => Promise<void>;
  };
  constructor(connection: MarionetteConnection, options: FirefoxBrowser["options"] = {}) {
    this.connection = connection;
    this.options = options;
  }

  get liveTabs() {
    return [...this.tabs.values()].map(({ threadId, tabId }) => ({
      threadId,
      tabId,
      visible: false,
    }));
  }

  private serial<A>(run: () => Promise<A>) {
    const pending = this.queue.then(run);
    this.queue = pending.catch(() => undefined);
    return pending;
  }

  private async connected() {
    if (this.disposed) throw new Error("The Firefox preview is closed.");
    if (this.connection.connected) return;
    await this.bidi?.command("session.end", {}).catch(() => undefined);
    this.bidi?.close();
    this.bidi = undefined;
    const staleTabs = [...this.tabs.values()];
    this.tabs.clear();
    await this.connection.connect();
    if (this.options.bidiPort)
      this.bidiDiagnostic = await bidiPortStatus(this.options.bidiPort, this.connection.processId);
    this.originalHandle ??= value<string>(
      await this.connection.command("WebDriver:GetWindowHandle"),
    );
    for (const tab of staleTabs) {
      await this.connection
        .command("WebDriver:SwitchToWindow", { handle: tab.handle, focus: false })
        .then(() => this.connection.command("WebDriver:CloseWindow"))
        .catch(() => undefined);
    }
    if (this.connection.webSocketUrl) {
      this.bidi = await FirefoxBidi.connect(this.connection.webSocketUrl, (method, params) =>
        this.event(method, params),
      ).catch(() => undefined);
      await this.bidi
        ?.command("session.subscribe", {
          events: [
            "browsingContext.userPromptOpened",
            "browsingContext.userPromptClosed",
            "log.entryAdded",
            "network.responseCompleted",
            "network.fetchError",
          ],
        })
        .catch(() => {
          this.bidi?.close();
          this.bidi = undefined;
        });
    }
  }

  private event(method: string, params: Record<string, unknown>) {
    const source = params.source as { context?: string } | undefined;
    const tab = [...this.tabs.values()].find(
      (tab) => tab.handle === (params.context ?? source?.context),
    );
    if (!tab) return;
    if (method === "browsingContext.userPromptOpened")
      tab.dialog = {
        type: String(params.type),
        message: String(params.message).slice(0, 4000),
        defaultValue: String(params.defaultValue ?? "").slice(0, 4000),
      };
    else if (method === "browsingContext.userPromptClosed") tab.dialog = null;
    else if (method === "log.entryAdded")
      bounded(tab.consoleEntries, {
        level: String(params.level),
        text: String(params.text ?? "").slice(0, 4000),
        timestamp: new Date().toISOString(),
      });
    else if (method.startsWith("network.")) {
      const request = params.request as { url: string; method: string };
      const response = params.response as { status: number } | undefined;
      bounded(tab.networkEntries, {
        url: request.url,
        method: request.method,
        status: response?.status ?? null,
        failed: method === "network.fetchError",
        timestamp: new Date().toISOString(),
      });
    }
  }

  private async switchTo(tab: Tab, frames: ReadonlyArray<Element> = []) {
    await this.connection.command("WebDriver:SwitchToWindow", { handle: tab.handle, focus: true });
    await this.connection.command("WebDriver:SwitchToFrame", { id: null });
    for (const frame of frames)
      await this.connection.command("WebDriver:SwitchToFrame", { element: frame });
  }

  private async script<A>(
    script: string,
    args: ReadonlyArray<unknown> = [],
    async = false,
    isolated = true,
  ): Promise<A> {
    const result = await this.connection.command(
      async ? "WebDriver:ExecuteAsyncScript" : "WebDriver:ExecuteScript",
      {
        script,
        args,
        ...(isolated ? { sandbox: "t3-preview", newSandbox: false } : {}),
        filename: "t3-preview",
        line: 1,
      },
    );
    return value<A>(result);
  }

  private async target(
    tab: Tab,
    input: {
      locator?: string | undefined;
      selector?: string | undefined;
      timeoutMs?: number | undefined;
    },
  ) {
    const selector = input.locator ?? input.selector;
    if (selector === undefined) return null;
    const frames = selector.startsWith("aria-ref=") ? tab.refs.get(selector.slice(9)) : [];
    if (!frames)
      throw new ServerBrowserOperationError({
        tag: "PreviewAutomationInvalidSelectorError",
        message: "This element ref is stale or belongs to another tab. Take a fresh snapshot.",
      });
    await this.switchTo(tab, frames);
    let element = await this.script<Element | null>(PageScript.RESOLVE, [selector]);
    if (!element && !selector.startsWith("aria-ref=")) {
      await this.wait({ locator: selector }, input.timeoutMs ?? 15_000);
      element = await this.script<Element | null>(PageScript.RESOLVE, [selector]);
    }
    if (!element)
      throw new ServerBrowserOperationError({
        tag: "PreviewAutomationInvalidSelectorError",
        message: "No element matches the locator. Wait for it or take a fresh snapshot.",
      });
    return element;
  }

  private async focused() {
    for (let depth = 0; depth < 32; depth++) {
      const focused = await this.script<{
        element: Element;
        frame: boolean;
      }>(`let el=document.activeElement;
        while (el?.shadowRoot?.activeElement) el=el.shadowRoot.activeElement;
        return {element:el,frame:el?.tagName === 'IFRAME' || el?.tagName === 'FRAME'};`);
      if (!focused.frame) return focused.element;
      await this.connection.command("WebDriver:SwitchToFrame", { element: focused.element });
    }
    throw new ServerBrowserOperationError({
      tag: "PreviewAutomationTargetNotEditableError",
      message: "The focused field is nested too deeply.",
    });
  }

  private async pointer(
    tab: Tab,
    input: PreviewAutomationHoverInput,
    tail: ReadonlyArray<Record<string, unknown>> = [],
  ) {
    const target = await this.target(tab, input);
    if (target)
      await this.script("arguments[0].scrollIntoView({block:'center',inline:'center'});", [target]);
    await this.connection.command("WebDriver:PerformActions", {
      actions: [
        {
          type: "pointer",
          id: "mouse",
          parameters: { pointerType: "mouse" },
          actions: [
            {
              type: "pointerMove",
              origin: target ?? "viewport",
              x: target ? 0 : Math.round(input.x ?? 0),
              y: target ? 0 : Math.round(input.y ?? 0),
              duration: 0,
            },
            ...tail,
          ],
        },
      ],
    });
  }

  private async press(input: PreviewAutomationPressInput) {
    const keys = [...(input.modifiers ?? []), ...input.key.split("+")].map((key) => {
      if (key === "ControlOrMeta")
        key = this.connection.platformName.toLowerCase().includes("mac") ? "Meta" : "Control";
      const mapped =
        KEY[key] ??
        (/^F([1-9]|1[0-2])$/.test(key) ? String.fromCharCode(0xe030 + Number(key.slice(1))) : key);
      if ([...mapped].length !== 1) unsupported(`Firefox does not recognize the key ${key}.`);
      return mapped;
    });
    await this.connection.command("WebDriver:PerformActions", {
      actions: [
        {
          type: "key",
          id: "keyboard",
          actions: [
            ...keys.map((value) => ({ type: "keyDown", value })),
            ...keys.toReversed().map((value) => ({ type: "keyUp", value })),
          ],
        },
      ],
    });
  }

  private async observeEvent(event: string, target: Element | null = null) {
    await this.script(
      `const [event,target] = arguments;
      globalThis.t3Event = new Promise(resolve => {
        const node = target ?? window;
        const finish = () => { clearTimeout(timer); node.removeEventListener(event,finish); resolve(); };
        const timer = setTimeout(finish,1000);
        node.addEventListener(event,finish,{once:true});
      });`,
      [event, target],
    );
  }

  private async eventSettled() {
    await this.script(
      "const done=arguments[arguments.length-1]; globalThis.t3Event.then(()=>done(null));",
      [],
      true,
    );
  }

  private async wait(
    input: PreviewAutomationWaitForInput & { readyState?: string },
    timeoutMs: number,
  ) {
    const result = await this.script<boolean | { error: string }>(
      PageScript.WAIT,
      [input, Math.max(1, timeoutMs - 100)],
      true,
    );
    if (result === false)
      throw new ServerBrowserOperationError({
        tag: "PreviewAutomationTimeoutError",
        message: "The Firefox wait conditions did not hold before the deadline.",
      });
    if (result !== true)
      throw new ServerBrowserOperationError({
        tag: "PreviewAutomationInvalidSelectorError",
        message: "The Firefox wait locator is invalid.",
      });
  }

  private async navigate(tab: Tab, input: PreviewAutomationNavigateInput, timeout: number) {
    const target = input.target;
    const url =
      input.url ??
      (target?.kind === "url"
        ? target.url
        : target
          ? `${target.protocol ?? "http"}://localhost:${target.port}/${(target.path ?? "").replace(/^\//, "")}`
          : undefined);
    if (!url) throw new Error("Navigation requires a URL.");
    tab.refs.clear();
    if (input.readiness === "none" || input.readiness === "domContentLoaded") {
      if (!this.bidi)
        return unsupported(
          "Firefox needs WebDriver BiDi for navigation readiness other than 'load'; Marionette's page-load strategy is session-wide.",
        );
      await this.bidi.command("browsingContext.navigate", {
        context: tab.handle,
        url: normalizePreviewUrl(url),
        wait: input.readiness === "none" ? "none" : "interactive",
      });
      return;
    }
    await this.connection.command("WebDriver:Navigate", { url: normalizePreviewUrl(url) });
    await this.wait({ readyState: "complete" }, timeout);
  }

  private async status(
    tab: Tab | undefined,
    request: PreviewAutomationRequest,
  ): Promise<PreviewAutomationStatus> {
    const common = () => ({
      backend: "firefox" as const,
      capabilityMessage:
        this.bidiDiagnostic ??
        (this.bidi
          ? "Firefox Marionette and BiDi connected."
          : "Firefox is connected with limited capabilities: BiDi is off. Start Firefox with --marionette --remote-debugging-port=<free-port> for 1Password autofill and appearance control."),
      profiles: [{ id: "firefox", name: "Firefox" }],
      defaultProfileId: "firefox",
      tabs: [...this.tabs.values()]
        .filter((tab) => tab.threadId === request.threadId)
        .map((tab) => ({
          tabId: tab.tabId,
          url: tab.url,
          owner: "agent" as const,
          ownedByCaller: tab.owner === request.agentSessionId,
          visible: false,
          profileId: "firefox",
        })),
    });
    if (!tab)
      return {
        available: false,
        visible: false,
        tabId: null,
        url: null,
        title: null,
        loading: false,
        ...common(),
      };
    await this.connection.command("WebDriver:SwitchToWindow", { handle: tab.handle, focus: false });
    try {
      const message = value<string>(await this.connection.command("WebDriver:GetAlertText"));
      tab.dialog = {
        type: tab.dialog?.type ?? "dialog",
        message,
        defaultValue: tab.dialog?.defaultValue ?? "",
      };
    } catch (cause) {
      if (!isMarionetteError(cause) || cause.code !== "no such alert") throw cause;
      tab.dialog = null;
    }
    let loading = false;
    if (!tab.dialog) {
      await this.connection.command("WebDriver:SwitchToFrame", { id: null });
      const metadata = await this.script<{
        url: string;
        title: string;
        loading: boolean;
        width: number;
        height: number;
      }>(
        "return {url:location.href,title:document.title,loading:document.readyState !== 'complete',width:innerWidth,height:innerHeight};",
      );
      tab.url = metadata.url === "about:blank" ? null : metadata.url;
      tab.title = metadata.title || null;
      tab.viewport = { width: metadata.width, height: metadata.height };
      loading = metadata.loading;
    }
    return {
      ...common(),
      available: true,
      visible: false,
      tabId: tab.tabId,
      url: tab.url,
      title: tab.title,
      loading,
      dialog: tab.dialog,
      control: {
        owner: "agent",
        ownedByCaller: tab.owner === request.agentSessionId,
        generation: 0,
      },
      viewport: tab.viewport,
      viewportSetting: tab.setting,
      downloads: [],
      fileChooser: null,
    };
  }

  private async snapshot(
    tab: Tab,
    input: PreviewAutomationSnapshotInput,
  ): Promise<PreviewAutomationSnapshot> {
    tab.refs.clear();
    const prefix = `t3-${NodeCrypto.randomUUID()}`;
    const collect = async (frames: ReadonlyArray<Element>, depth: number): Promise<Collected> => {
      await this.switchTo(tab, frames);
      const page = await this.script<Collected>(PageScript.COLLECT, [`${prefix}-${tab.refs.size}`]);
      for (const el of page.interactiveElements) tab.refs.set(el.selector.slice(9), frames);
      if (depth < 8)
        for (const frame of page.frames) {
          const child = await collect([...frames, frame], depth + 1);
          page.visibleText += `\n${child.visibleText}`;
          page.accessibilityTree += `\n${child.accessibilityTree
            .split("\n")
            .map((line) => `  ${line}`)
            .join("\n")}`;
          page.interactiveElements = [...page.interactiveElements, ...child.interactiveElements];
        }
      return page;
    };
    const page = await collect([], 0);
    await this.switchTo(tab);
    const data = value<string>(
      await this.connection.command("WebDriver:TakeScreenshot", { full: false, scroll: false }),
    );
    const bytes = Buffer.from(data, "base64");
    const width = bytes.readUInt32BE(16);
    const height = bytes.readUInt32BE(20);
    const small =
      width <= 1280
        ? data
        : await this.script<string>(
            `const [data,done] = arguments; const image = new Image(); image.onload = () => {const canvas = document.createElement('canvas'); canvas.width=1280; canvas.height=Math.round(image.height*1280/image.width); canvas.getContext('2d').drawImage(image,0,0,canvas.width,canvas.height); done(canvas.toDataURL('image/png').split(',')[1]);}; image.onerror=()=>done(null); image.src='data:image/png;base64,'+data;`,
            [data],
            true,
          );
    if (!small) throw new Error("Firefox could not resize the screenshot.");
    const png = Buffer.from(small, "base64");
    return {
      url: page.url,
      title: page.title,
      loading: page.loading,
      visibleText: page.visibleText.slice(0, 20_000),
      interactiveElements: page.interactiveElements,
      accessibilityTree: page.accessibilityTree.slice(0, 20_000),
      consoleEntries: [...tab.consoleEntries],
      networkEntries: [...tab.networkEntries],
      actionTimeline: [...tab.actionTimeline],
      screenshot: {
        mimeType: "image/png",
        data: small,
        width: png.readUInt32BE(16),
        height: png.readUInt32BE(20),
      },
      ...(input.fullScreenshot && small !== data
        ? { fullScreenshot: { data, width, height } }
        : {}),
    };
  }

  execute(request: PreviewAutomationRequest): Promise<unknown> {
    const deadline = Date.now() + request.timeoutMs;
    return this.serial(async () => {
      try {
        const timeoutMs = deadline - Date.now();
        if (timeoutMs <= 0)
          throw new ServerBrowserOperationError({
            tag: "PreviewAutomationTimeoutError",
            message: "The Firefox request expired before it could run.",
          });
        const result = await this.run({ ...request, timeoutMs });
        if (result && typeof result === "object" && "available" in result)
          await this.options.status?.(result as PreviewAutomationStatus, request);
        return result;
      } catch (cause) {
        if (isMarionetteError(cause)) {
          const remote = cause.cause as { message?: string } | undefined;
          const tag = ["timeout", "script timeout"].includes(cause.code)
            ? "PreviewAutomationTimeoutError"
            : ["invalid selector", "stale element reference"].includes(cause.code) ||
                /T3_(STALE_REF|AMBIGUOUS_SELECTOR|UNSUPPORTED_SELECTOR)/.test(remote?.message ?? "")
              ? "PreviewAutomationInvalidSelectorError"
              : ["unsupported operation", "unknown command"].includes(cause.code)
                ? "PreviewAutomationUnsupportedClientError"
                : "PreviewAutomationExecutionError";
          throw new ServerBrowserOperationError({ tag, message: cause.message, cause });
        }
        throw toOperationError(cause, request.timeoutMs);
      }
    });
  }

  private async run(request: PreviewAutomationRequest, managedTabId?: string) {
    await this.connected();
    await this.connection.command("WebDriver:SetTimeouts", {
      script: request.timeoutMs,
      pageLoad: request.timeoutMs,
      implicit: 0,
    });
    const owned = [...this.tabs.values()].filter(
      (tab) => tab.threadId === request.threadId && tab.owner === request.agentSessionId,
    );
    let tab = request.tabId === undefined ? owned.at(-1) : this.tabs.get(request.tabId);
    if (tab?.threadId !== request.threadId) tab = undefined;
    if (request.operation === "status") return this.status(tab, request);
    if (!request.agentSessionId)
      throw new BrowserControlInterrupted({
        message: "The agent session is missing. Reconnect the provider.",
      });
    if (
      !request.tabIdExplicit &&
      owned.length > 1 &&
      !(
        request.operation === "open" &&
        (request.input as PreviewAutomationOpenInput).reuseExistingTab === false
      )
    )
      throw new BrowserControlInterrupted({
        message: "Multiple tabs are open. Pass tabId.",
        reason: "tabRequired",
      });
    if (request.operation === "open") {
      const input = request.input as PreviewAutomationOpenInput;
      let created = false;
      if (input.profileId !== undefined && input.profileId !== "firefox")
        unsupported(
          "Firefox uses the connected Firefox profile. Choose profileId 'firefox' or omit it.",
        );
      if (input.reuseExistingTab === false) tab = undefined;
      if (request.tabIdExplicit && !tab)
        throw new ServerBrowserOperationError({
          tag: "PreviewAutomationTabNotFoundError",
          message: "This Firefox preview tab does not exist.",
        });
      if (tab && tab.owner !== request.agentSessionId)
        throw new BrowserControlInterrupted({
          message: "This tab belongs to another agent session.",
          reason: "agentMismatch",
        });
      if (!tab) {
        if (owned.length >= 8 || this.tabs.size >= 32)
          throw new Error("The Firefox preview tab limit has been reached.");
        const handles = value<string[]>(
          await this.connection.command("WebDriver:GetWindowHandles"),
        );
        const current =
          [...this.tabs.values()].find((tab) => handles.includes(tab.handle))?.handle ??
          (this.originalHandle && handles.includes(this.originalHandle)
            ? this.originalHandle
            : handles[0]);
        if (current)
          await this.connection.command("WebDriver:SwitchToWindow", {
            handle: current,
            focus: false,
          });
        const opened = value<{ handle: string }>(
          await this.connection.command("WebDriver:NewWindow", {
            type: this.options.docked?.() && this.tabs.size === 0 ? "window" : "tab",
            focus: false,
          }),
        );
        tab = {
          threadId: request.threadId,
          tabId:
            managedTabId ?? (await this.options.allocateTab?.(request)) ?? NodeCrypto.randomUUID(),
          handle: opened.handle,
          owner: request.agentSessionId,
          refs: new Map(),
          consoleEntries: [],
          networkEntries: [],
          actionTimeline: [],
          setting: { _tag: "fill" },
          url: null,
          title: null,
          viewport: { width: 1280, height: 800 },
          dialog: null,
        };
        this.tabs.set(tab.tabId, tab);
        created = true;
      }
      try {
        await this.switchTo(tab);
        if (created && this.options.docked?.() && this.connection.processId)
          await this.options.opened?.(tab, this.connection.processId);
        if (input.url) await this.navigate(tab, { url: input.url }, request.timeoutMs);
        return await this.status(tab, request);
      } catch (cause) {
        if (created) {
          this.tabs.delete(tab.tabId);
          await this.connection
            .command("WebDriver:SwitchToWindow", { handle: tab.handle, focus: false })
            .then(() => this.connection.command("WebDriver:CloseWindow"))
            .catch(() => undefined);
        }
        throw cause;
      }
    }
    if (!tab)
      throw new ServerBrowserOperationError({
        tag: "PreviewAutomationTabNotFoundError",
        message: "No Firefox preview tab is open. Call preview_open first.",
      });
    if (
      !["snapshot", "waitFor"].includes(request.operation) &&
      tab.owner !== request.agentSessionId
    )
      throw new BrowserControlInterrupted({
        message: "This tab belongs to another agent session.",
        reason: "agentMismatch",
      });
    await this.connection.command("WebDriver:SwitchToWindow", { handle: tab.handle, focus: true });
    if (request.operation !== "dialog" && request.operation !== "close")
      await this.connection.command("WebDriver:SwitchToFrame", { id: null });
    const active = tab;
    const event: PreviewAutomationActionEvent = {
      id: NodeCrypto.randomUUID(),
      action: request.operation,
      status: "running",
      startedAt: new Date().toISOString(),
    };
    if (!["snapshot", "waitFor"].includes(request.operation))
      bounded(tab.actionTimeline, event, 50);
    try {
      const result = await this.operation(tab, request);
      Object.assign(event, { status: "succeeded", completedAt: new Date().toISOString() });
      return result;
    } catch (cause) {
      Object.assign(event, { status: "failed", completedAt: new Date().toISOString() });
      throw cause;
    } finally {
      if (
        this.connection.connected &&
        this.tabs.has(active.tabId) &&
        request.operation !== "dialog"
      )
        await this.connection.command("WebDriver:ReleaseActions").catch(() => undefined);
    }
  }

  private async operation(tab: Tab, request: PreviewAutomationRequest): Promise<unknown> {
    switch (request.operation) {
      case "navigate":
        await this.navigate(
          tab,
          request.input as PreviewAutomationNavigateInput,
          request.timeoutMs,
        );
        return this.status(tab, request);
      case "close":
        await this.connection.command("WebDriver:CloseWindow");
        this.tabs.delete(tab.tabId);
        await this.options.closed?.(tab);
        return {};
      case "autofill":
        if (this.bidiDiagnostic) unsupported(this.bidiDiagnostic);
        if (!this.options.autofill?.supported)
          unsupported("1Password OS autofill is supported only by Firefox on macOS.");
        if (!this.bidi)
          unsupported(
            "Firefox BiDi is off. Restart Firefox with --marionette --remote-debugging-port=<free-port> to use preview_autofill.",
          );
        if (!this.connection.processId)
          unsupported("Firefox did not report its process ID; OS autofill is unavailable.");
        return autofillFirefox(
          this.bidi!,
          tab.handle,
          this.connection.processId!,
          request.input as import("@t3tools/contracts").PreviewAutomationAutofillInput,
          this.options.autofill!,
          () => this.autofillFrames(),
        );
      case "dialog": {
        const input = request.input as PreviewAutomationDialogInput;
        if (input.accept && input.promptText !== undefined)
          await this.connection.command("WebDriver:SendAlertText", { text: input.promptText });
        await this.connection.command(
          input.accept ? "WebDriver:AcceptAlert" : "WebDriver:DismissAlert",
        );
        tab.dialog = null;
        return this.status(tab, request);
      }
      case "snapshot":
        return this.snapshot(tab, (request.input ?? {}) as PreviewAutomationSnapshotInput);
      case "click": {
        const input = request.input as PreviewAutomationClickInput;
        const button = { left: 0, middle: 1, right: 2 }[input.button ?? "left"];
        await this.pointer(
          tab,
          input,
          Array.from({ length: input.clickCount ?? 1 }, () => [
            { type: "pointerDown", button },
            { type: "pointerUp", button },
          ]).flat(),
        );
        return;
      }
      case "hover":
        return this.pointer(tab, request.input as PreviewAutomationHoverInput);
      case "press":
        return this.press(request.input as PreviewAutomationPressInput);
      case "type": {
        const input = request.input as PreviewAutomationTypeInput;
        const target = (await this.target(tab, input)) ?? (await this.focused());
        const editable = await this.script<boolean>(
          `const el=arguments[0]; return !el.disabled && !el.readOnly && (el.isContentEditable || el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && !['button','checkbox','color','file','hidden','image','radio','range','reset','submit'].includes(el.type)));`,
          [target],
        );
        if (!editable)
          throw new ServerBrowserOperationError({
            tag: "PreviewAutomationTargetNotEditableError",
            message: "The target is not an enabled text field.",
          });
        await this.script("arguments[0].focus();", [target]);
        if (input.clear)
          await this.connection.command("WebDriver:ElementClear", { id: elementId(target) });
        // ElementSendKeys performs WebDriver's native keyboard input and supports Unicode text.
        await this.connection.command("WebDriver:ElementSendKeys", {
          id: elementId(target),
          text: input.text,
        });
        return;
      }
      case "select": {
        const input = request.input as PreviewAutomationSelectInput;
        const target = await this.target(tab, input);
        const options = await this.script<Array<{
          element: Element;
          value: string;
          label: string;
          selected: boolean;
        }> | null>(
          "const el=arguments[0]; return el.tagName === 'SELECT' ? [...el.options].map(option=>({element:option,value:option.value,label:option.label.trim(),selected:option.selected})) : null;",
          [target],
        );
        if (!options)
          throw new ServerBrowserOperationError({
            tag: "PreviewAutomationTargetNotEditableError",
            message: "This element is not a <select>.",
          });
        const chosen = input.values.map(
          (entry) =>
            options.find((option) => option.value === entry) ??
            options.find((option) => option.label === entry.trim()),
        );
        if (chosen.some((option) => !option)) throw new Error("The select option does not exist.");
        const multiple = await this.script<boolean>("return arguments[0].multiple;", [target]);
        for (const option of options)
          if (
            (multiple && option.selected !== chosen.includes(option)) ||
            (!multiple && chosen.includes(option))
          )
            await this.connection.command("WebDriver:ElementClick", {
              id: elementId(option.element),
            });
        return { selected: chosen.map((option) => option!.value) };
      }
      case "scroll": {
        const input = request.input as PreviewAutomationScrollInput;
        const target = await this.target(tab, input);
        if (target) await this.script("arguments[0].scrollIntoView({block:'center'});", [target]);
        await this.pointer(tab, input);
        await this.observeEvent("scroll", target);
        await this.connection.command("WebDriver:PerformActions", {
          actions: [
            {
              type: "wheel",
              id: "wheel",
              actions: [
                {
                  type: "scroll",
                  origin: target ?? "viewport",
                  x: 0,
                  y: 0,
                  deltaX: Math.round(input.deltaX ?? 0),
                  deltaY: Math.round(input.deltaY ?? 0),
                  duration: 0,
                },
              ],
            },
          ],
        });
        await this.eventSettled();
        return;
      }
      case "drag": {
        const input = request.input as PreviewAutomationDragInput;
        const source = await this.target(tab, { locator: input.source });
        const target = await this.target(tab, { locator: input.target });
        if (
          input.source.startsWith("aria-ref=") &&
          input.target.startsWith("aria-ref=") &&
          JSON.stringify(tab.refs.get(input.source.slice(9))) !==
            JSON.stringify(tab.refs.get(input.target.slice(9)))
        )
          unsupported("Firefox cannot drag across frames using Classic actions.");
        await this.connection.command("WebDriver:PerformActions", {
          actions: [
            {
              type: "pointer",
              id: "mouse",
              parameters: { pointerType: "mouse" },
              actions: [
                { type: "pointerMove", origin: source, x: 0, y: 0, duration: 0 },
                { type: "pointerDown", button: 0 },
                { type: "pointerMove", origin: target, x: 0, y: 0, duration: 250 },
                { type: "pointerUp", button: 0 },
              ],
            },
          ],
        });
        return;
      }
      case "upload": {
        const input = request.input as PreviewAutomationUploadInput;
        if (input.paths.some((path) => !NodePath.isAbsolute(path)))
          throw new Error("Upload paths must be absolute.");
        const target = await this.target(tab, input);
        if (!target)
          return unsupported(
            "Firefox uploads require a locator for an input[type=file]; native file chooser interception is unavailable in Marionette.",
          );
        if (input.paths.length === 0)
          await this.connection.command("WebDriver:ElementClear", { id: elementId(target) });
        else
          await this.connection.command("WebDriver:ElementSendKeys", {
            id: elementId(target),
            text: input.paths.join("\n"),
          });
        return;
      }
      case "waitFor": {
        const input = request.input as PreviewAutomationWaitForInput;
        const selector = input.locator ?? input.selector;
        if (selector?.startsWith("aria-ref=")) await this.target(tab, input);
        return this.wait(input, input.timeoutMs ?? request.timeoutMs);
      }
      case "evaluate": {
        const input = request.input as PreviewAutomationEvaluateInput;
        if (input.returnByValue === false)
          unsupported(
            "Firefox Classic evaluation returns JSON values; remote object handles are unavailable.",
          );
        const result =
          input.awaitPromise === false
            ? await this.script<unknown>(
                `return (0,eval)(${JSON.stringify(input.expression)});`,
                [],
                false,
                false,
              )
            : await this.script<unknown>(
                `const done=arguments[arguments.length-1]; Promise.resolve().then(()=>(0,eval)(${JSON.stringify(input.expression)})).then(value=>done({ok:true,value}),error=>done({ok:false}));`,
                [],
                true,
                false,
              );
        const evaluated =
          input.awaitPromise === false
            ? result
            : (result as { ok: boolean; value?: unknown }).value;
        if (input.awaitPromise !== false && !(result as { ok: boolean }).ok)
          throw new ServerBrowserOperationError({
            tag: "PreviewAutomationExecutionError",
            message: "The Firefox page expression threw an error.",
          });
        if (Buffer.byteLength(JSON.stringify(evaluated ?? null)) > 64_000)
          throw new ServerBrowserOperationError({
            tag: "PreviewAutomationResultTooLargeError",
            message: "The evaluation result exceeds 64000 bytes.",
            detail: { maximumBytes: 64_000 },
          });
        return evaluated;
      }
      case "resize": {
        const setting = resolvePreviewViewport(request.input as PreviewAutomationResizeInput);
        const size = setting._tag === "fill" ? { width: 1280, height: 800 } : setting;
        // SetWindowRect controls the outer window; compensate for Firefox's actual chrome size.
        const chrome = await this.script<{ width: number; height: number }>(
          "return {width:outerWidth-innerWidth,height:outerHeight-innerHeight};",
        );
        await this.observeEvent("resize");
        await this.connection.command("WebDriver:SetWindowRect", {
          width: size.width + chrome.width,
          height: size.height + chrome.height,
        });
        await this.eventSettled();
        const viewport = await this.script<{ width: number; height: number }>(
          "return {width:innerWidth,height:innerHeight};",
        );
        tab.setting = setting;
        tab.viewport = viewport;
        return { tabId: tab.tabId, setting, viewport };
      }
      case "setColorScheme": {
        const { colorScheme } = request.input as PreviewAutomationSetColorSchemeInput;
        if (!this.bidi)
          return unsupported(
            "Per-tab color scheme requires Firefox WebDriver BiDi. Start Firefox with --remote-debugging-port=0 as well as --marionette.",
          );
        await this.bidi.command("emulation.setMediaFeaturesOverride", {
          contexts: [tab.handle],
          features: colorScheme === "system" ? null : { "prefers-color-scheme": colorScheme },
        });
        return { tabId: tab.tabId, colorScheme };
      }
      case "recordingStart":
      case "recordingStop":
        unsupported(
          "Firefox Marionette and WebDriver BiDi do not provide a screencast/video stream. Use preview_snapshot for PNG captures or the Playwright backend for recording.",
        );
      default:
        unsupported(`Firefox does not implement ${request.operation}.`);
    }
  }

  private async autofillFrames() {
    const hosts = value<Element[]>(
      await this.connection.command("WebDriver:FindElements", {
        using: "css selector",
        value: "com-1password-uso",
      }),
    );
    const frames: Array<{ url: string; rect: Rect }> = [];
    for (const host of hosts) {
      // WebDriver exposes closed shadow roots, unlike page JavaScript's host.shadowRoot.
      const root = value<Record<string, string>>(
        await this.connection.command("WebDriver:GetShadowRoot", { id: Object.values(host)[0] }),
      );
      const elements = value<Element[]>(
        await this.connection.command("WebDriver:FindElementsFromShadowRoot", {
          shadowRoot: Object.values(root)[0],
          using: "css selector",
          value: "iframe",
        }),
      );
      for (const element of elements)
        frames.push(
          await this.script<{ url: string; rect: Rect }>(
            "const el=arguments[0],r=el.getBoundingClientRect(),sx=r.width/el.offsetWidth,sy=r.height/el.offsetHeight;return {url:el.src,rect:{x:r.x+el.clientLeft*sx,y:r.y+el.clientTop*sy,width:el.clientWidth*sx,height:el.clientHeight*sy}};",
            [element],
          ),
        );
    }
    return frames;
  }

  openManaged(snapshot: import("@t3tools/contracts").PreviewSessionSnapshot) {
    return this.serial(async () => {
      const request: PreviewAutomationRequest = {
        requestId: "desktop-open",
        threadId: ThreadId.make(snapshot.threadId),
        agentSessionId: snapshot.automationOwner ?? "desktop-human",
        operation: "open",
        input: {
          reuseExistingTab: false,
          ...(snapshot.navStatus._tag === "Idle" ? {} : { url: snapshot.navStatus.url }),
        },
        timeoutMs: 15_000,
      };
      const result = (await this.run(request, snapshot.tabId)) as PreviewAutomationStatus;
      await this.options.status?.(result, request);
      return result;
    });
  }

  closeTab(tabId: string) {
    return this.serial(async () => {
      const tab = this.tabs.get(tabId);
      if (!tab) return;
      this.tabs.delete(tabId);
      await this.connection
        .command("WebDriver:SwitchToWindow", { handle: tab.handle, focus: false })
        .then(() => this.connection.command("WebDriver:CloseWindow"))
        .catch(() => undefined);
      await this.options.closed?.(tab);
    });
  }

  close() {
    return this.serial(async () => {
      this.disposed = true;
      if (this.connection.connected) {
        for (const tab of this.tabs.values()) {
          await this.connection
            .command("WebDriver:SwitchToWindow", { handle: tab.handle, focus: false })
            .then(() => this.connection.command("WebDriver:CloseWindow"))
            .catch(() => undefined);
          await this.options.closed?.(tab);
        }
        if (this.originalHandle)
          await this.connection
            .command("WebDriver:SwitchToWindow", { handle: this.originalHandle, focus: false })
            .catch(() => undefined);
      }
      this.tabs.clear();
      await this.bidi?.command("session.end", {}).catch(() => undefined);
      this.bidi?.close();
    });
  }

  history(input: ServerBrowserHistoryInput) {
    return this.serial(async () => {
      await this.connected();
      const tab = this.tabs.get(input.tabId);
      if (!tab || tab.threadId !== input.threadId)
        throw new ServerBrowserOperationError({
          tag: "PreviewAutomationTabNotFoundError",
          message: "This Firefox preview tab does not exist.",
        });
      await this.switchTo(tab);
      tab.refs.clear();
      if (input.ignoreCache) {
        if (!this.bidi)
          return unsupported(
            "Firefox needs WebDriver BiDi to bypass the cache for a reload without changing profile preferences.",
          );
        try {
          await this.bidi.command("browsingContext.reload", {
            context: tab.handle,
            ignoreCache: true,
            wait: "complete",
          });
        } catch (cause) {
          if (
            isMarionetteError(cause) &&
            ["unsupported operation", "unknown command"].includes(cause.code)
          )
            return unsupported(
              "This Firefox version does not implement BiDi cache-bypassing reload.",
            );
          throw toOperationError(cause);
        }
        return;
      }
      await this.connection.command("WebDriver:SetTimeouts", {
        script: 15000,
        pageLoad: 15000,
        implicit: 0,
      });
      await this.connection.command(
        { back: "WebDriver:Back", forward: "WebDriver:Forward", reload: "WebDriver:Refresh" }[
          input.direction
        ],
      );
    });
  }
}
