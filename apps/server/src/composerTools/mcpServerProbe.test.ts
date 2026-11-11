import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as FetchHttpClient from "effect/http/FetchHttpClient";

import type { ConfiguredMcpServer } from "./mcpConfigFiles.ts";
import { probeMcpServer } from "./mcpServerProbe.ts";

const layer = Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer);

// A stdio server that answers the handshake and lists one tool; it never answers tools/call.
const REPLYING_SERVER = `
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "fake", version: "1" } } });
  } else if (message.method === "tools/list") {
    send({ jsonrpc: "2.0", id: message.id, result: { tools: [{ name: "echo", description: "Echo the input" }] } });
  }
});
`;

// A stdio server that starts and never replies.
const SILENT_SERVER = `setInterval(() => {}, 1000);`;

const stdioServer = (name: string, script: string): ConfiguredMcpServer => ({
  name,
  transport: { type: "stdio", command: process.execPath, args: ["-e", script], env: {}, cwd: null },
});

const httpServer = (name: string, url: string): ConfiguredMcpServer => ({
  name,
  transport: { type: "http", url, headers: {} },
});

it.live("lists a stdio server's tools after the handshake", () =>
  Effect.gen(function* () {
    const result = yield* probeMcpServer(stdioServer("fake", REPLYING_SERVER));
    expect(result).toEqual({
      status: "ready",
      tools: [{ name: "echo", description: "Echo the input" }],
    });
  }).pipe(Effect.provide(layer)),
);

it.live("reports a server that does not answer before the timeout as down", () =>
  Effect.gen(function* () {
    const result = yield* probeMcpServer(stdioServer("silent", SILENT_SERVER), {
      timeout: "300 millis",
    });
    expect(result).toEqual({ status: "down" });
  }).pipe(Effect.provide(layer)),
);

it.effect("reports an HTTP 401 as needs-auth", () =>
  Effect.gen(function* () {
    const client = HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(request, new Response("unauthorized", { status: 401 })),
      ),
    );
    const result = yield* probeMcpServer(httpServer("docs", "https://docs.example/mcp")).pipe(
      Effect.provideService(HttpClient.HttpClient, client),
    );
    expect(result).toEqual({ status: "needs-auth" });
  }).pipe(Effect.provide(NodeServices.layer)),
);
