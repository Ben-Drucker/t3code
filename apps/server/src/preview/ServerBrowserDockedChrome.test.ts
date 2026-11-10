// @effect-diagnostics nodeBuiltinImport:off -- Exercises the manifest copy against a real temporary directory.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { expect, it } from "vite-plus/test";

import {
  copyNativeMessagingManifests,
  parseSingletonLockPid,
} from "./ServerBrowserDockedChrome.ts";

it("copies only 1Password manifests into the profile and refreshes them", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "docked-chrome-"));
  try {
    const hosts = NodePath.join(
      root,
      "home/Library/Application Support/Google/Chrome/NativeMessagingHosts",
    );
    const profile = NodePath.join(root, "profile");
    await NodeFSP.mkdir(hosts, { recursive: true });
    await NodeFSP.mkdir(NodePath.join(profile, "NativeMessagingHosts"), { recursive: true });
    await NodeFSP.writeFile(NodePath.join(hosts, "com.1password.1password.json"), "new");
    await NodeFSP.writeFile(NodePath.join(hosts, "2bua8c4s2c.com.agilebits.1password.json"), "new");
    await NodeFSP.writeFile(NodePath.join(hosts, "com.other.host.json"), "other");
    const stale = NodePath.join(profile, "NativeMessagingHosts", "com.1password.1password.json");
    const keep = NodePath.join(profile, "NativeMessagingHosts", "com.keep.json");
    await NodeFSP.writeFile(stale, "old");
    await NodeFSP.writeFile(keep, "keep");

    const copied = await copyNativeMessagingManifests({
      homeDir: NodePath.join(root, "home"),
      profileDir: profile,
    });

    expect([...copied].sort()).toEqual([
      "2bua8c4s2c.com.agilebits.1password.json",
      "com.1password.1password.json",
    ]);
    expect(await NodeFSP.readFile(stale, "utf8")).toBe("new");
    expect(await NodeFSP.readFile(keep, "utf8")).toBe("keep");
    await expect(
      NodeFSP.stat(NodePath.join(profile, "NativeMessagingHosts", "com.other.host.json")),
    ).rejects.toThrow();
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});

it("reads the owning pid from Chrome's SingletonLock target", () => {
  expect(parseSingletonLockPid("my-mac.local-4321")).toBe(4321);
  expect(parseSingletonLockPid("garbage")).toBeNull();
});
