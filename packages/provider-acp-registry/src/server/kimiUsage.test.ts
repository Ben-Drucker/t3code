import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import {
  kimiWindowMinutes,
  parseKimiCredentials,
  parseKimiUsagePayload,
  probeKimiUsage,
  isKimiAgent,
  readKimiResetsAt,
  resolveKimiCredentialsDirectory,
  resolveKimiUsageUrl,
} from "./kimiUsage.ts";

const NOW = Date.parse("2026-10-31T12:00:00.000Z");

// Redacted copy of a real Kimi Code `/usages` response (2.3.3, 2026-11-01). Counters arrive as
// strings; the wallet and ratio blocks are ignored.
const USAGES_FIXTURE = {
  usage: { limit: "100", used: "40", remaining: "60", resetTime: "2026-11-03T18:38:33.770861Z" },
  limits: [
    {
      window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
      detail: { limit: "100", remaining: "90", resetTime: "2026-10-31T15:00:00.770861Z" },
    },
  ],
  booster_wallet: { id: "redacted", status: "STATUS_ACTIVE", allowTopup: true },
  usages: {
    limit_5h: { used_ratio: 0.1, reset_time: "2026-10-31T15:00:00Z" },
    limit_7d: { used_ratio: 0.4, reset_time: "2026-11-03T18:38:33Z" },
  },
};

describe("parseKimiUsagePayload", () => {
  it("maps the account allowance to weekly and rolling limits to session windows", () => {
    expect(parseKimiUsagePayload(USAGES_FIXTURE, NOW)).toEqual([
      {
        id: "session",
        kind: "session",
        label: "5-hour",
        usedPercent: 10,
        resetsAt: "2026-10-31T15:00:00.770Z",
        windowDurationMins: 300,
      },
      {
        id: "weekly",
        kind: "weekly",
        label: "Weekly",
        usedPercent: 40,
        resetsAt: "2026-11-03T18:38:33.770Z",
        windowDurationMins: 10_080,
      },
    ]);
  });

  it("accepts numbers, `used` counters and clamps to 0-100", () => {
    const windows = parseKimiUsagePayload({ usage: { limit: 10, used: 25 } }, NOW);
    expect(windows).toHaveLength(1);
    expect(windows[0]?.usedPercent).toBe(100);
    const over = parseKimiUsagePayload({ usage: { limit: 10, remaining: 12 } }, NOW);
    expect(over[0]?.usedPercent).toBe(0);
  });

  it("labels other window lengths without inventing a kind", () => {
    const windows = parseKimiUsagePayload(
      {
        limits: [
          {
            window: { duration: 1, timeUnit: "TIME_UNIT_DAY" },
            detail: { limit: 10, remaining: 5 },
          },
        ],
      },
      NOW,
    );
    expect(windows).toEqual([
      expect.objectContaining({
        id: "window-1440",
        kind: "other",
        label: "1-day",
        usedPercent: 50,
        windowDurationMins: 1440,
      }),
    ]);
  });

  it("returns nothing for unusable payloads instead of throwing", () => {
    for (const payload of [null, "x", 3, [], {}, { usage: { limit: 0, remaining: 0 } }]) {
      expect(parseKimiUsagePayload(payload, NOW)).toEqual([]);
    }
  });
});

describe("kimi helpers", () => {
  it("reads reset times in several spellings", () => {
    expect(readKimiResetsAt({ reset_at: "2026-11-03T00:00:00Z" }, NOW)).toBe(
      "2026-11-03T00:00:00.000Z",
    );
    expect(readKimiResetsAt({ resetTime: 1_793_000_000 }, NOW)).toBe("2026-10-26T07:33:20.000Z");
    expect(readKimiResetsAt({ resetTime: 1_793_000_000_000 }, NOW)).toBe(
      "2026-10-26T07:33:20.000Z",
    );
    expect(readKimiResetsAt({ reset_in: 3600 }, NOW)).toBe("2026-10-31T13:00:00.000Z");
    expect(readKimiResetsAt({}, NOW)).toBeUndefined();
  });

  it("converts window units to minutes", () => {
    expect(kimiWindowMinutes({ duration: 300, timeUnit: "TIME_UNIT_MINUTE" })).toBe(300);
    expect(kimiWindowMinutes({ duration: 5, timeUnit: "TIME_UNIT_HOUR" })).toBe(300);
    expect(kimiWindowMinutes({ duration: 1, timeUnit: "WEEK" })).toBe(10_080);
    expect(kimiWindowMinutes({ duration: "300" })).toBe(300);
    expect(kimiWindowMinutes({ timeUnit: "TIME_UNIT_MINUTE" })).toBeUndefined();
    expect(kimiWindowMinutes(undefined)).toBeUndefined();
  });

  it("reads CLI credentials in either casing and ignores bad files", () => {
    expect(
      parseKimiCredentials('{"access_token":" abc ","refresh_token":"r","expires_at":1793000000}'),
    ).toEqual({ accessToken: "abc", expiresAtMs: 1_793_000_000_000 });
    expect(parseKimiCredentials('{"accessToken":"abc"}')).toEqual({ accessToken: "abc" });
    expect(parseKimiCredentials("not json")).toBeUndefined();
    expect(parseKimiCredentials('{"access_token":""}')).toBeUndefined();
    expect(parseKimiCredentials("[]")).toBeUndefined();
  });

  it.effect("finds credentials under KIMI_CODE_HOME or ~/.kimi-code", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      expect(
        resolveKimiCredentialsDirectory({ path, environment: {}, homeDirectory: "/home/u" }),
      ).toBe(path.join("/home/u", ".kimi-code", "credentials"));
      expect(
        resolveKimiCredentialsDirectory({
          path,
          environment: { KIMI_CODE_HOME: "/data/kimi" },
          homeDirectory: "/home/u",
        }),
      ).toBe(path.join("/data/kimi", "credentials"));
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it("recognises the registry agent and a local kimi command", () => {
    expect(isKimiAgent({ source: "registry", agentId: "kimi" })).toBe(true);
    expect(isKimiAgent({ source: "registry", agentId: "claude-acp" })).toBe(false);
    expect(isKimiAgent({ source: "local", commandPath: "/home/u/.kimi-code/bin/kimi" })).toBe(true);
    expect(isKimiAgent({ source: "local", commandPath: "C:\\tools\\kimi.exe" })).toBe(true);
    expect(isKimiAgent({ source: "local", commandPath: "/usr/bin/kimi-helper" })).toBe(false);
  });

  it("honours KIMI_CODE_BASE_URL", () => {
    expect(resolveKimiUsageUrl({})).toBe("https://api.kimi.com/coding/v1/usages");
    expect(resolveKimiUsageUrl({ KIMI_CODE_BASE_URL: "https://example.test/v1/" })).toBe(
      "https://example.test/v1/usages",
    );
  });
});

describe("probeKimiUsage", () => {
  const withHome = (
    credentials: string | null,
    respond: (request: {
      readonly url: string;
      readonly authorization: string | undefined;
    }) => Response,
    run: (
      home: string,
    ) => Effect.Effect<unknown, never, FileSystem.FileSystem | Path.Path | HttpClient.HttpClient>,
  ) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-kimi-home-" });
      if (credentials !== null) {
        yield* fs.makeDirectory(path.join(home, ".kimi-code", "credentials"), { recursive: true });
        yield* fs.writeFileString(
          path.join(home, ".kimi-code", "credentials", "kimi-code-env-abc.json"),
          credentials,
        );
        // The CLI also leaves a token-less stub next to the live file.
        yield* fs.writeFileString(
          path.join(home, ".kimi-code", "credentials", "kimi-code.json"),
          '{"note":"stub"}',
        );
      }
      const client = HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            respond({ url: request.url, authorization: request.headers.authorization }),
          ),
        ),
      );
      return yield* run(home).pipe(Effect.provideService(HttpClient.HttpClient, client));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

  it.effect("sends the CLI token and returns quota windows", () => {
    let seen: { url: string; authorization: string | undefined } | undefined;
    return withHome(
      '{"access_token":"secret-token"}',
      (request) => {
        seen = request;
        return Response.json(USAGES_FIXTURE);
      },
      (home) =>
        probeKimiUsage({ environment: {}, homeDirectory: home }).pipe(
          Effect.tap((limits) =>
            Effect.sync(() => {
              expect(limits.unavailable).toBeUndefined();
              expect(limits.windows.map((window) => window.id)).toEqual(["session", "weekly"]);
            }),
          ),
        ),
    ).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          expect(seen).toEqual({
            url: "https://api.kimi.com/coding/v1/usages",
            authorization: "Bearer secret-token",
          });
        }),
      ),
    );
  });

  it.effect("reports a missing sign-in as unsupported without calling the service", () =>
    withHome(
      null,
      () => {
        throw new Error("must not call the quota service without a token");
      },
      (home) =>
        probeKimiUsage({ environment: {}, homeDirectory: home }).pipe(
          Effect.tap((limits) =>
            Effect.sync(() => {
              expect(limits.unavailable?.reason).toBe("unsupported");
              expect(limits.windows).toEqual([]);
            }),
          ),
        ),
    ),
  );

  it.live("does not use an expired token", () =>
    withHome(
      '{"access_token":"old","expires_at":1000}',
      () => {
        throw new Error("must not call the quota service with an expired token");
      },
      (home) =>
        probeKimiUsage({ environment: {}, homeDirectory: home }).pipe(
          Effect.tap((limits) =>
            Effect.sync(() => {
              expect(limits.unavailable?.reason).toBe("probeFailed");
              expect(limits.unavailable?.message).toContain("stale");
            }),
          ),
        ),
    ),
  );

  it.effect("turns 401 and bad bodies into a failed probe", () =>
    Effect.gen(function* () {
      for (const response of [
        () => new Response("nope", { status: 401 }),
        () => new Response("boom", { status: 500 }),
        () => Response.json({ unexpected: true }),
      ]) {
        yield* withHome('{"access_token":"t"}', response, (home) =>
          probeKimiUsage({ environment: {}, homeDirectory: home }).pipe(
            Effect.tap((limits) =>
              Effect.sync(() => {
                expect(limits.unavailable?.reason).toBe("probeFailed");
                expect(limits.windows).toEqual([]);
              }),
            ),
          ),
        );
      }
    }),
  );
});
