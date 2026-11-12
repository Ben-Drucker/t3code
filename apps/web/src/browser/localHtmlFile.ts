import {
  AuthFilesystemReadScope,
  type DesktopEnvironmentBootstrap,
  type EnvironmentId,
} from "@t3tools/contracts";
import { resolvePathLinkTarget } from "@t3tools/shared/fileLinks";
import { isAbsolutePath, isNetworkPath, isWindowsDrivePath } from "@t3tools/shared/path";

import { readEnvironmentScope, readPreparedConnection } from "~/state/session";

export function localHtmlFileUrl(input: {
  readonly filePath: string;
  readonly workspaceRoot: string | undefined;
  readonly httpBaseUrl: string;
  readonly bootstraps: ReadonlyArray<DesktopEnvironmentBootstrap>;
}): string | null {
  if (
    !input.bootstraps.some(
      (entry) =>
        entry.runningDistro === null &&
        entry.httpBaseUrl !== null &&
        new URL(entry.httpBaseUrl).href === new URL(input.httpBaseUrl).href,
    )
  )
    return null;
  if (!input.workspaceRoot && !isAbsolutePath(input.filePath)) return null;
  const path = resolvePathLinkTarget(input.filePath, input.workspaceRoot ?? "");
  if (!/\.html?$/i.test(path) || isNetworkPath(path)) return null;
  const windows = isWindowsDrivePath(path);
  if (!windows && !path.startsWith("/")) return null;
  const normalized = windows ? `/${path.replaceAll("\\", "/")}` : path;
  return `file://${normalized
    .split("/")
    .map((segment, index) => (windows && index === 1 ? segment : encodeURIComponent(segment)))
    .join("/")}`;
}

export function readLocalHtmlFileUrl(
  environmentId: EnvironmentId,
  filePath: string,
  workspaceRoot: string | undefined,
): string | null {
  if (!/\.html?$/i.test(filePath)) return null;
  const bridge = typeof window === "undefined" ? undefined : window.desktopBridge;
  if (!bridge) return null;
  if (!readEnvironmentScope(environmentId, AuthFilesystemReadScope)) return null;
  const connection = readPreparedConnection(environmentId);
  if (!connection) return null;
  try {
    return localHtmlFileUrl({
      filePath,
      workspaceRoot,
      httpBaseUrl: connection.httpBaseUrl,
      bootstraps: bridge.getLocalEnvironmentBootstraps(),
    });
  } catch {
    return null;
  }
}
