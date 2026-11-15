import type { EnvironmentServerConfig } from "@t3tools/client-runtime/connection";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import { AuthPreviewOperateScope, type EnvironmentId } from "@t3tools/contracts";
import type { ClientSettings } from "@t3tools/contracts/settings";
import { Atom } from "effect/reactivity";

import {
  getClientSettings,
  getClientSettingsHydratedSnapshot,
  subscribeClientSettings,
  subscribeClientSettingsHydration,
} from "~/hooks/useSettings";
import { isElectron } from "~/env";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { environmentPresentations } from "~/state/presentation";
import { hostEnvironmentIdAtom, primaryEnvironmentIdAtom } from "~/state/primaryEnvironment";
import { previewEnvironment } from "~/state/preview";
import { environmentSession, sessionHasScope } from "~/state/session";

export interface ProfileReport {
  readonly profiles: ClientSettings["browserProfiles"];
  readonly defaultProfileId: ClientSettings["browserDefaultProfileId"];
  readonly recordingFrameRate: ClientSettings["browserRecordingFrameRate"];
  readonly previewBrowserMode?: ClientSettings["browserPreviewMode"];
}

/** Server-browser environments this client may operate, with the config each currently runs. */
const reportTargetsAtom = Atom.make((get) => {
  const targets = new Map<EnvironmentId, EnvironmentServerConfig>();
  for (const [environmentId, config] of get(environmentPresentations.serverConfigsAtom)) {
    if (!config.environment.capabilities.serverBrowser) continue;
    const session = get(environmentSession.sessionStateAtom(environmentId));
    if (!sessionHasScope(session, AuthPreviewOperateScope)) continue;
    targets.set(environmentId, config);
  }
  return targets;
}).pipe(Atom.withLabel("browser-profile-report-targets"));

/**
 * Keeps every operable server browser on this client's profiles. An environment is reported
 * again when its server config changes (a restarted server has forgotten them), when it becomes
 * operable, and when the profile settings change.
 */
export function startBrowserProfileReporting(): () => void {
  const reported: ReportedProfiles = new Map();
  const report = () => {
    if (!getClientSettingsHydratedSnapshot()) return;
    const settings = getClientSettings();
    const input: ProfileReport = {
      profiles: settings.browserProfiles,
      defaultProfileId: settings.browserDefaultProfileId,
      recordingFrameRate: settings.browserRecordingFrameRate,
      previewBrowserMode: settings.browserPreviewMode,
    };
    const targets = appAtomRegistry.get(reportTargetsAtom);
    // Only the desktop app's own server can be docked by this client's native window.
    const nativeEnvironmentId = isElectron ? appAtomRegistry.get(primaryEnvironmentIdAtom) : null;
    const hostEnvironmentId = isElectron ? appAtomRegistry.get(hostEnvironmentIdAtom) : null;
    for (const environmentId of takeDueProfileReports(
      reported,
      targets,
      input,
      nativeEnvironmentId,
      hostEnvironmentId,
    )) {
      void runAtomCommand(
        appAtomRegistry,
        previewEnvironment.reportProfiles,
        {
          environmentId,
          input: profileReportFor(input, environmentId, nativeEnvironmentId, hostEnvironmentId),
        },
        { reportFailure: false },
      );
    }
  };
  const unsubscribes = [
    appAtomRegistry.subscribe(reportTargetsAtom, report),
    appAtomRegistry.subscribe(primaryEnvironmentIdAtom, report),
    appAtomRegistry.subscribe(hostEnvironmentIdAtom, report),
    subscribeClientSettings(report),
    subscribeClientSettingsHydration(report),
  ];
  report();
  return () => {
    for (const unsubscribe of unsubscribes) unsubscribe();
  };
}

export type ReportedProfiles = Map<
  EnvironmentId,
  { readonly config: EnvironmentServerConfig; readonly input: ProfileReport }
>;

/**
 * Returns the targets that need `input` reported and records them in `reported`. An
 * environment that dropped out of `targets` is forgotten, so it is reported again once it
 * becomes operable.
 */
export function takeDueProfileReports(
  reported: ReportedProfiles,
  targets: ReadonlyMap<EnvironmentId, EnvironmentServerConfig>,
  input: ProfileReport,
  nativeEnvironmentId: EnvironmentId | null = null,
  hostEnvironmentId: string | null = null,
): EnvironmentId[] {
  for (const environmentId of reported.keys()) {
    if (!targets.has(environmentId)) reported.delete(environmentId);
  }
  const due: EnvironmentId[] = [];
  for (const [environmentId, config] of targets) {
    const last = reported.get(environmentId);
    const effective = profileReportFor(
      input,
      environmentId,
      nativeEnvironmentId,
      hostEnvironmentId,
    );
    if (last && last.config === config && sameReportInput(last.input, effective)) continue;
    reported.set(environmentId, { config, input: effective });
    due.push(environmentId);
  }
  return due;
}

/**
 * The preview browser mode picks how the server opens browsers, and the server keeps the last
 * mode any client reported. Only the desktop app's own environment can dock a native window, so
 * every other target omits the mode and keeps the mode the desktop reported.
 */
export function profileReportFor(
  input: ProfileReport,
  environmentId: EnvironmentId,
  nativeEnvironmentId: EnvironmentId | null,
  hostEnvironmentId: string | null = null,
): ProfileReport {
  if (environmentId === (nativeEnvironmentId ?? hostEnvironmentId)) return input;
  const { previewBrowserMode: _omitted, ...rest } = input;
  return rest;
}

function sameReportInput(left: ProfileReport, right: ProfileReport): boolean {
  return (
    left.profiles === right.profiles &&
    left.defaultProfileId === right.defaultProfileId &&
    left.recordingFrameRate === right.recordingFrameRate &&
    left.previewBrowserMode === right.previewBrowserMode
  );
}
