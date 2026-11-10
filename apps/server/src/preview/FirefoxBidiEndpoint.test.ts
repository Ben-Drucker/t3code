// @effect-diagnostics nodeBuiltinImport:off -- The fixture owns only its local HTTP listener.
import { expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as NodeHttp from "node:http";
import { bidiPortStatus, firefoxBidiPort } from "./FirefoxBidiEndpoint.ts";

it("validates an explicit BiDi port without assuming Chrome's default", () => {
  expect(firefoxBidiPort(undefined)).toBeUndefined();
  expect(firefoxBidiPort("9333")).toBe(9333);
  for (const value of ["0", "65536", "1.2", "no", ""])
    expect(() => firefoxBidiPort(value)).toThrow();
});

it.live("diagnoses a configured BiDi port owned by Chrome or another HTTP service", () =>
  Effect.gen(function* () {
    let kind = "chrome";
    const server = yield* Effect.acquireRelease(
      Effect.promise(async () => {
        const listener = NodeHttp.createServer((_request, response) => {
          response.statusCode = kind === "firefox" ? 404 : 200;
          response.end(JSON.stringify(kind === "chrome" ? { Browser: "Chrome/150.0" } : {}));
        });
        await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
        return listener;
      }),
      (listener) =>
        Effect.promise(
          () =>
            new Promise<void>((resolve, reject) =>
              listener.close((error) => (error ? reject(error) : resolve())),
            ),
        ),
    );
    const port = (server.address() as { port: number }).port;
    expect(yield* Effect.promise(() => bidiPortStatus(port))).toContain(
      "owned by a Chromium browser",
    );
    kind = "unknown";
    expect(yield* Effect.promise(() => bidiPortStatus(port))).toContain("occupied by a service");
    kind = "firefox";
    expect(yield* Effect.promise(() => bidiPortStatus(port))).toBeUndefined();
  }),
);
