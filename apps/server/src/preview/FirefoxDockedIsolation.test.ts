// @effect-diagnostics nodeBuiltinImport:off -- Tests Firefox profile lock symlinks in temporary directories.
import { assert, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { FirefoxBrowser } from "./FirefoxBrowser.ts";
import {
  buildFirefoxLaunchArgs,
  parseFirefoxLockTarget,
  readFirefoxProfileOwnerPid,
} from "./FirefoxProcess.ts";
import { resolveFirefoxLaunchPlan } from "./FirefoxServerBrowser.ts";
import { MarionetteError, type MarionetteConnection } from "./MarionetteClient.ts";

function fakeMarionette(initialHandles: string[] = ["initial-window"]) {
  const handles = [...initialHandles];
  const commands: Array<{ readonly name: string; readonly params: Record<string, unknown> }> = [];
  let nextHandle = 1;
  const connection = {
    connected: true,
    processId: 9999,
    platformName: "mac",
    webSocketUrl: undefined,
    options: {},
    connect: async () => undefined,
    close: async () => undefined,
    command: async (name: string, params: Record<string, unknown> = {}) => {
      commands.push({ name, params });
      switch (name) {
        case "WebDriver:GetWindowHandle":
          return { value: handles[0] ?? "initial-window" };
        case "WebDriver:GetWindowHandles":
          return { value: [...handles] };
        case "WebDriver:NewWindow": {
          const handle = `opened-${nextHandle++}`;
          handles.push(handle);
          return { value: { handle, type: params.type } };
        }
        case "WebDriver:CloseWindow":
          handles.pop();
          return { value: [] };
        case "WebDriver:GetAlertText":
          return Promise.reject(new MarionetteError({ code: "no such alert", command: name }));
        case "WebDriver:ExecuteScript":
          return {
            value: {
              url: "about:blank",
              title: "",
              loading: false,
              width: 540,
              height: 800,
            },
          };
        default:
          return { value: null };
      }
    },
  } as unknown as MarionetteConnection;
  return { connection, commands, handles };
}

it("attaches docked Firefox to the personal profile by default", () => {
  const plan = resolveFirefoxLaunchPlan({
    env: {},
    platform: "darwin",
    profilesDir: "/tmp/t3-profiles",
  });
  assert.deepStrictEqual(plan, {
    kind: "attach",
    port: 2828,
    bidiPort: undefined,
    allowDocking: true,
  });

  const args = buildFirefoxLaunchArgs("/tmp/t3-profiles/firefox-docked", {
    headless: false,
    allowSystemAccess: true,
  });
  assert.include(args, "--no-remote");
  assert.include(args, "--profile");
  assert.include(args, "/tmp/t3-profiles/firefox-docked");
  assert.include(args, "--marionette");
  assert.include(args, "--remote-allow-system-access");
  assert.notInclude(args, "--headless");

  const attached = resolveFirefoxLaunchPlan({
    env: { T3CODE_FIREFOX_MODE: "attach" },
    platform: "darwin",
  });
  assert.strictEqual(attached.kind, "attach");
  if (attached.kind === "attach") assert.isTrue(attached.allowDocking);
});

it("parses Firefox profile lock symlinks", async () => {
  assert.strictEqual(parseFirefoxLockTarget("127.0.0.1:+48291"), 48291);
  assert.isNull(parseFirefoxLockTarget("invalid"));

  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-ff-lock-"));
  try {
    assert.isNull(await readFirefoxProfileOwnerPid(dir));
    await NodeFSP.symlink("127.0.0.1:+12345", NodePath.join(dir, "lock"));
    assert.strictEqual(await readFirefoxProfileOwnerPid(dir), 12345);
  } finally {
    await NodeFSP.rm(dir, { recursive: true, force: true });
  }
});

it("reuses an isolated initial window and docks a dedicated marked window in personal Firefox", async () => {
  const marionette = fakeMarionette(["owned-initial"]);
  // Prime connection as disconnected first so `connected()` captures `originalHandle`.
  (marionette.connection as { connected: boolean }).connected = false;
  marionette.connection.connect = async () => {
    (marionette.connection as { connected: boolean }).connected = true;
  };
  const dockedCalls: Array<{ tabId: string; pid: number }> = [];
  const revealCalls: string[] = [];
  const ownedBrowser = new FirefoxBrowser(marionette.connection, {
    ownedProcessId: 4242,
    reuseInitialWindow: true,
    docked: () => true,
    allocateTab: async () => "tab-1",
    opened: async (key, pid) => {
      dockedCalls.push({ tabId: key.tabId, pid });
    },
    reveal: async (key) => {
      revealCalls.push(key.tabId);
    },
  });

  await ownedBrowser.execute({
    requestId: "r1",
    threadId: ThreadId.make("t1"),
    agentSessionId: "agent-1",
    operation: "open",
    input: {},
    timeoutMs: 5_000,
  });

  // Reused the initial blank window rather than spawning a second window; docked pid 4242 (not 9999); no duplicate reveal.
  assert.strictEqual(marionette.commands.filter((c) => c.name === "WebDriver:NewWindow").length, 0);
  assert.deepStrictEqual(dockedCalls, [{ tabId: "tab-1", pid: 4242 }]);
  assert.deepStrictEqual(revealCalls, []);

  // Attached Firefox (`ownedProcessId` undefined) must NEVER invoke `opened` to dock personal windows.
  const personal = fakeMarionette(["personal-window"]);
  const personalDocked: number[] = [];
  const attachedBrowser = new FirefoxBrowser(personal.connection, {
    ownedProcessId: 9999,
    docked: () => true,
    allocateTab: async () => "tab-personal",
    opened: async (_key, pid) => {
      personalDocked.push(pid);
    },
  });
  await attachedBrowser.execute({
    requestId: "r2",
    threadId: ThreadId.make("t1"),
    agentSessionId: "agent-1",
    operation: "open",
    input: {},
    timeoutMs: 5_000,
  });
  assert.deepStrictEqual(personalDocked, [9999]);
  assert.deepStrictEqual(personal.commands.find((c) => c.name === "WebDriver:NewWindow")?.params, {
    type: "window",
    focus: false,
  });
  assert.isTrue(
    personal.commands.some(
      (c) =>
        c.name === "WebDriver:ExecuteScript" && String(c.params.script).includes("titlepreface"),
    ),
  );
  assert.isTrue(attachedBrowser.liveTabs[0]?.visible);
});
