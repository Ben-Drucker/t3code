/**
 * Fork: Kimi Code quota from the CLI's own sign-in; never refreshes the token. UNVERIFIED against a
 * real account (endpoint, credential file and response shape): see docs/fork/CLOUD-HANDOFF.md.
 */
import type { ServerProviderUsageLimits, ServerProviderUsageWindow } from "@t3tools/contracts";
import {
  makeUnavailableUsageLimits,
  makeUsageLimits,
  clampPercent,
} from "@t3tools/provider-core/server/usageLimits";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { resolveKimiShareDirectory } from "./kimiSession.ts";
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

/** The ACP registry agent id this applies to. */
export const KIMI_REGISTRY_AGENT_ID = "kimi";

const DEFAULT_KIMI_CODE_BASE_URL = "https://api.kimi.com/coding/v1";
const SESSION_WINDOW_MINS = 5 * 60;
const WEEKLY_WINDOW_MINS = 7 * 24 * 60;
const SIGN_IN_AGAIN_MESSAGE = "Kimi sign-in expired. Run `kimi login` in a terminal to refresh it.";

type UnknownRecord = Readonly<Record<string, unknown>>;

const asRecord = (value: unknown): UnknownRecord | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as UnknownRecord)
    : undefined;

/** Kimi serialises some counters as strings. */
const toNumber = (value: unknown): number | undefined => {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
};

const firstNumber = (record: UnknownRecord, keys: ReadonlyArray<string>): number | undefined => {
  for (const key of keys) {
    const value = toNumber(record[key]);
    if (value !== undefined) return value;
  }
  return undefined;
};

const isoFromMillis = (millis: number): string => DateTime.formatIso(DateTime.makeUnsafe(millis));

/** Epoch seconds and milliseconds are both seen; anything past year 2286 in seconds is milliseconds. */
const epochToMillis = (value: number): number => (value > 1e11 ? value : value * 1000);

/** The reset moment, from whichever spelling the service used. */
export function readKimiResetsAt(record: UnknownRecord, nowMs: number): string | undefined {
  for (const key of [
    "resetTime",
    "reset_time",
    "resetAt",
    "reset_at",
    "resetsAt",
    "resets_at",
    "expiresAt",
    "expires_at",
  ]) {
    const value = record[key];
    const numeric = toNumber(value);
    if (numeric !== undefined && typeof value !== "string") {
      return isoFromMillis(epochToMillis(numeric));
    }
    if (typeof value === "string" && value.trim() !== "") {
      const asNumber = toNumber(value);
      const millis = asNumber !== undefined ? epochToMillis(asNumber) : Date.parse(value);
      if (Number.isFinite(millis)) return isoFromMillis(millis);
    }
  }
  const relativeSeconds = firstNumber(record, ["resetIn", "reset_in", "ttl", "remainingSeconds"]);
  return relativeSeconds === undefined ? undefined : isoFromMillis(nowMs + relativeSeconds * 1000);
}

/** Minutes for a `{ duration, timeUnit }` pair such as `{ duration: 300, timeUnit: "TIME_UNIT_MINUTE" }`. */
export function kimiWindowMinutes(window: unknown): number | undefined {
  const record = asRecord(window);
  if (record === undefined) return undefined;
  const duration = firstNumber(record, ["duration", "length", "size"]);
  if (duration === undefined || duration <= 0) return undefined;
  const unit = String(record.timeUnit ?? record.time_unit ?? record.unit ?? "MINUTE")
    .toUpperCase()
    .replace(/^TIME_UNIT_/, "");
  if (unit.startsWith("SECOND")) return Math.round(duration / 60);
  if (unit.startsWith("MINUTE")) return Math.round(duration);
  if (unit.startsWith("HOUR")) return Math.round(duration * 60);
  if (unit.startsWith("DAY")) return Math.round(duration * 24 * 60);
  if (unit.startsWith("WEEK")) return Math.round(duration * 7 * 24 * 60);
  return undefined;
}

function describeWindow(minutes: number | undefined): {
  readonly id: string;
  readonly kind: ServerProviderUsageWindow["kind"];
  readonly label: string;
} {
  if (minutes === SESSION_WINDOW_MINS) return { id: "session", kind: "session", label: "5-hour" };
  if (minutes === WEEKLY_WINDOW_MINS) return { id: "weekly", kind: "weekly", label: "Weekly" };
  if (minutes === undefined) return { id: "other", kind: "other", label: "Quota" };
  const label =
    minutes % (24 * 60) === 0
      ? `${minutes / (24 * 60)}-day`
      : minutes % 60 === 0
        ? `${minutes / 60}-hour`
        : `${minutes}-minute`;
  return { id: `window-${minutes}`, kind: "other", label };
}

/** One quota row (`{ limit, remaining | used, resetTime }`) as a usage window, or undefined when unusable. */
function windowFromQuota(
  quota: unknown,
  minutes: number | undefined,
  nowMs: number,
): ServerProviderUsageWindow | undefined {
  const record = asRecord(quota);
  if (record === undefined) return undefined;
  const limit = firstNumber(record, ["limit", "total", "quota"]);
  if (limit === undefined || limit <= 0) return undefined;
  const used = firstNumber(record, ["used", "consumed"]);
  const remaining = firstNumber(record, ["remaining", "left"]);
  const consumed = used ?? (remaining === undefined ? undefined : limit - remaining);
  if (consumed === undefined) return undefined;
  const resetsAt = readKimiResetsAt(record, nowMs);
  const description = describeWindow(minutes);
  return {
    id: description.id,
    kind: description.kind,
    label: description.label,
    usedPercent: clampPercent((consumed / limit) * 100),
    ...(resetsAt === undefined ? {} : { resetsAt }),
    ...(minutes === undefined ? {} : { windowDurationMins: minutes }),
  };
}

/**
 * Windows from a `/usages` response: the account-level `usage` block is the weekly allowance and
 * each `limits[]` entry is a rolling window (the 5-hour one in practice).
 */
export function parseKimiUsagePayload(
  payload: unknown,
  nowMs: number,
): ReadonlyArray<ServerProviderUsageWindow> {
  const root = asRecord(payload);
  if (root === undefined) return [];
  const windows = new Map<string, ServerProviderUsageWindow>();
  const add = (window: ServerProviderUsageWindow | undefined) => {
    if (window === undefined) return;
    const previous = windows.get(window.id);
    if (previous === undefined || window.usedPercent > previous.usedPercent) {
      windows.set(window.id, window);
    }
  };
  add(windowFromQuota(root.usage, WEEKLY_WINDOW_MINS, nowMs));
  const limits = Array.isArray(root.limits) ? root.limits : [];
  for (const entry of limits) {
    const record = asRecord(entry);
    if (record === undefined) continue;
    add(
      windowFromQuota(
        record.detail ?? record,
        kimiWindowMinutes(record.window) ?? kimiWindowMinutes(record),
        nowMs,
      ),
    );
  }
  return makeUsageLimits({ checkedAt: isoFromMillis(nowMs), windows: windows.values() }).windows;
}

export interface KimiCredential {
  readonly accessToken: string;
  /** Epoch milliseconds, when the CLI recorded one. */
  readonly expiresAtMs?: number;
}

/** The CLI's `credentials/kimi-code.json`. Tolerates snake_case and camelCase. */
export function parseKimiCredentials(text: string): KimiCredential | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  const record = asRecord(parsed);
  if (record === undefined) return undefined;
  const token = record.access_token ?? record.accessToken;
  if (typeof token !== "string" || token.trim() === "") return undefined;
  const expiresAt = toNumber(record.expires_at ?? record.expiresAt);
  return {
    accessToken: token.trim(),
    ...(expiresAt === undefined ? {} : { expiresAtMs: epochToMillis(expiresAt) }),
  };
}

export function resolveKimiCredentialsPath(input: {
  readonly path: Path.Path;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly homeDirectory: string;
}): string {
  return input.path.join(resolveKimiShareDirectory(input), "credentials", "kimi-code.json");
}

export const resolveKimiUsageUrl = (
  environment: Readonly<Record<string, string | undefined>>,
): string =>
  `${(environment.KIMI_CODE_BASE_URL?.trim() || DEFAULT_KIMI_CODE_BASE_URL).replace(/\/+$/, "")}/usages`;

/** Reads the CLI's token and the account's quota windows. Never fails; problems become `unavailable`. */
export const probeKimiUsage = Effect.fn("KimiUsage.probe")(function* (input: {
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly homeDirectory: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
  const checkedAt = isoFromMillis(nowMs);
  const unavailable = (
    reason: "unsupported" | "probeFailed",
    message: string,
  ): ServerProviderUsageLimits => makeUnavailableUsageLimits({ checkedAt, reason, message });

  const credentialsPath = resolveKimiCredentialsPath({ ...input, path });
  const text = yield* fs.readFileString(credentialsPath).pipe(Effect.option);
  if (text._tag === "None") {
    return unavailable("unsupported", "Sign in with `kimi login` to see Kimi quota.");
  }
  const credential = parseKimiCredentials(text.value);
  if (credential === undefined) {
    return unavailable("probeFailed", "Could not read the Kimi CLI sign-in. Run `kimi login`.");
  }
  if (credential.expiresAtMs !== undefined && credential.expiresAtMs <= nowMs) {
    return unavailable("probeFailed", SIGN_IN_AGAIN_MESSAGE);
  }

  const client = yield* HttpClient.HttpClient;
  const response = yield* client
    .execute(
      HttpClientRequest.get(resolveKimiUsageUrl(input.environment)).pipe(
        HttpClientRequest.bearerToken(credential.accessToken),
        HttpClientRequest.acceptJson,
      ),
    )
    .pipe(
      Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
      Effect.timeout("10 seconds"),
      Effect.result,
    );
  if (response._tag === "Failure") {
    return unavailable("probeFailed", "Could not reach the Kimi quota service.");
  }
  if (response.success.status === 401 || response.success.status === 403) {
    return unavailable("probeFailed", SIGN_IN_AGAIN_MESSAGE);
  }
  const body = yield* HttpClientResponse.filterStatusOk(response.success).pipe(
    Effect.flatMap((ok) => ok.json),
    Effect.result,
  );
  if (body._tag === "Failure") {
    return unavailable("probeFailed", "The Kimi quota service returned an error.");
  }
  const windows = parseKimiUsagePayload(body.success, nowMs);
  if (windows.length === 0) {
    return unavailable("probeFailed", "Kimi did not return usable quota information.");
  }
  return makeUsageLimits({ checkedAt, windows });
});
