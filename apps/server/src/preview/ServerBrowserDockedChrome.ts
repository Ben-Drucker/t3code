// @effect-diagnostics nodeBuiltinImport:off -- Prepares a real Chrome profile on the host's disk.
import * as Schema from "effect/Schema";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

export const MAC_CHROME_EXECUTABLE = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
export const DOCKED_PROFILE_NAME = "chrome-docked";

/** 1Password's desktop-app link needs its native-messaging manifests in the profile Chrome runs. */
const isOnePasswordManifest = (name: string) =>
  name.endsWith(".json") && (name.includes("1password") || name.includes("agilebits"));

/** Copies only 1Password's manifests, every launch, so they never go stale. Other files stay untouched. */
export async function copyNativeMessagingManifests(input: {
  readonly homeDir: string;
  readonly profileDir: string;
}): Promise<ReadonlyArray<string>> {
  const source = NodePath.join(
    input.homeDir,
    "Library/Application Support/Google/Chrome/NativeMessagingHosts",
  );
  const names = await NodeFSP.readdir(source).catch(() => [] as string[]);
  const copied = names.filter(isOnePasswordManifest);
  if (copied.length === 0) return [];
  const destination = NodePath.join(input.profileDir, "NativeMessagingHosts");
  await NodeFSP.mkdir(destination, { recursive: true });
  for (const name of copied) {
    await NodeFSP.copyFile(NodePath.join(source, name), NodePath.join(destination, name));
  }
  return copied;
}

/** Chrome's SingletonLock is a symlink to `<host>-<pid>`; the pid names the process that owns the profile. */
export const parseSingletonLockPid = (target: string): number | null => {
  const pid = Number(/-(\d+)$/.exec(target)?.[1]);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
};

export const readProfileOwnerPid = async (profileDir: string): Promise<number | null> => {
  const target = await NodeFSP.readlink(NodePath.join(profileDir, "SingletonLock")).catch(
    () => null,
  );
  return target === null ? null : parseSingletonLockPid(target);
};

export const processAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    return (cause as NodeJS.ErrnoException).code === "EPERM";
  }
};

export class DockedChromeUnavailableError extends Schema.TaggedError<DockedChromeUnavailableError>()(
  "DockedChromeUnavailableError",
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}
