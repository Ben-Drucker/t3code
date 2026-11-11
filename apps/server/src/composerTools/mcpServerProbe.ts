import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as HttpBody from "effect/http/HttpBody";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";

import type { ConfiguredMcpServer, ConfiguredMcpTransport } from "./mcpConfigFiles.ts";

/** Only `initialize` and `tools/list` are sent (plus the `notifications/initialized` that completes the handshake). */
const PROTOCOL_VERSION = "2025-06-18";
const DEFAULT_TIMEOUT = Duration.seconds(5);
const MAX_TOOL_PAGES = 20;
const AUTH_ERROR = /unauthori[sz]ed|forbidden|\b40[13]\b|auth/i;

export interface McpProbeTool {
  readonly name: string;
  readonly description: string | null;
}

export type McpProbeResult =
  | { readonly status: "ready"; readonly tools: ReadonlyArray<McpProbeTool> }
  | { readonly status: "down" }
  | { readonly status: "needs-auth" };

class McpProbeFailure extends Schema.TaggedError<McpProbeFailure>()("McpProbeFailure", {
  reason: Schema.Literals(["auth", "down"]),
}) {}

const down = new McpProbeFailure({ reason: "down" });

type JsonRpcRequest = (method: string, params?: unknown) => Effect.Effect<unknown, McpProbeFailure>;

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const parseMessage = (text: string): Record<string, unknown> | undefined => {
  try {
    return asRecord(JSON.parse(text));
  } catch {
    return undefined;
  }
};

/** Messages carry an `id` for replies; server notifications and logs are ignored. */
const replyFor = (message: Record<string, unknown>, id: number) => message.id === id;

const failureForRpcError = (error: unknown) => {
  const message = asRecord(error)?.message;
  return new McpProbeFailure({
    reason: typeof message === "string" && AUTH_ERROR.test(message) ? "auth" : "down",
  });
};

const toolsFromListResult = (result: unknown): ReadonlyArray<McpProbeTool> => {
  const tools = asRecord(result)?.tools;
  if (!Array.isArray(tools)) return [];
  return tools.flatMap((value): McpProbeTool[] => {
    const tool = asRecord(value);
    if (typeof tool?.name !== "string") return [];
    const description = typeof tool.description === "string" ? tool.description : null;
    return [{ name: tool.name, description }];
  });
};

const listAllTools = Effect.fn("McpServerProbe.listAllTools")(function* (request: JsonRpcRequest) {
  const tools: McpProbeTool[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_TOOL_PAGES; page += 1) {
    const result = yield* request("tools/list", cursor === undefined ? {} : { cursor });
    tools.push(...toolsFromListResult(result));
    const nextCursor = asRecord(result)?.nextCursor;
    cursor = typeof nextCursor === "string" ? nextCursor : undefined;
    if (cursor === undefined) break;
  }
  return tools;
});

const probeStdio = Effect.fn("McpServerProbe.probeStdio")(function* (
  transport: Extract<ConfiguredMcpTransport, { type: "stdio" }>,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const command = yield* resolveSpawnCommand(transport.command, transport.args, {
    env: transport.env,
    extendEnv: true,
  });
  const child = yield* spawner
    .spawn(
      ChildProcess.make(command.command, command.args, {
        ...(transport.cwd === null ? {} : { cwd: transport.cwd }),
        env: transport.env,
        extendEnv: true,
        shell: command.shell,
        forceKillAfter: "1 second",
      }),
    )
    .pipe(Effect.mapError(() => down));

  const inbox = yield* Queue.unbounded<Record<string, unknown>>();
  const outbox = yield* Queue.unbounded<string>();
  yield* child.stdout.pipe(
    Stream.decodeText,
    Stream.splitLines,
    Stream.runForEach((line) => {
      const message = parseMessage(line);
      return message === undefined ? Effect.void : Queue.offer(inbox, message);
    }),
    Effect.forkScoped,
  );
  yield* Stream.fromQueue(outbox).pipe(
    Stream.encodeText,
    Stream.run(child.stdin),
    Effect.forkScoped,
  );

  const send = (message: unknown) => Queue.offer(outbox, `${JSON.stringify(message)}\n`);
  const awaitReply = (id: number): Effect.Effect<Record<string, unknown>> =>
    Queue.take(inbox).pipe(
      Effect.filterOrElse(
        (message) => replyFor(message, id),
        () => awaitReply(id),
      ),
    );
  // A server that exits before replying is down now, not after the timeout.
  const exited = child.exitCode.pipe(
    Effect.mapError(() => down),
    Effect.flatMap(() => Effect.fail(down)),
  );
  let nextId = 0;
  const request: JsonRpcRequest = Effect.fn("McpServerProbe.request")(function* (
    method: string,
    params?: unknown,
  ) {
    nextId += 1;
    const id = nextId;
    yield* send({ jsonrpc: "2.0", id, method, params });
    const reply = yield* Effect.raceFirst(awaitReply(id), exited);
    if (reply.error !== undefined) return yield* failureForRpcError(reply.error);
    return reply.result;
  });

  yield* request("initialize", {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: "T3 Code", version: "0" },
  });
  yield* send({ jsonrpc: "2.0", method: "notifications/initialized" });
  return yield* listAllTools(request);
});

const probeHttp = Effect.fn("McpServerProbe.probeHttp")(function* (
  transport: Extract<ConfiguredMcpTransport, { type: "http" }>,
) {
  const httpClient = yield* HttpClient.HttpClient;
  let sessionId: string | undefined;
  let nextId = 0;

  const post = (body: unknown) =>
    httpClient
      .execute(
        HttpClientRequest.post(transport.url).pipe(
          HttpClientRequest.setHeaders({
            ...transport.headers,
            accept: "application/json, text/event-stream",
            "mcp-protocol-version": PROTOCOL_VERSION,
            ...(sessionId === undefined ? {} : { "mcp-session-id": sessionId }),
          }),
          HttpClientRequest.setBody(HttpBody.text(JSON.stringify(body), "application/json")),
        ),
      )
      .pipe(Effect.mapError(() => down));

  const request: JsonRpcRequest = Effect.fn("McpServerProbe.request")(function* (
    method: string,
    params?: unknown,
  ) {
    nextId += 1;
    const id = nextId;
    const response = yield* post({ jsonrpc: "2.0", id, method, params });
    if (response.status === 401 || response.status === 403) {
      return yield* new McpProbeFailure({ reason: "auth" });
    }
    if (response.status < 200 || response.status >= 300) return yield* down;
    const sessionHeader = response.headers["mcp-session-id"];
    if (typeof sessionHeader === "string") sessionId = sessionHeader;
    const text = yield* response.text.pipe(Effect.mapError(() => down));
    const reply = messagesFromBody(text, response.headers["content-type"]).find((message) =>
      replyFor(message, id),
    );
    if (reply === undefined) return yield* down;
    if (reply.error !== undefined) return yield* failureForRpcError(reply.error);
    return reply.result;
  });

  yield* request("initialize", {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: "T3 Code", version: "0" },
  });
  yield* post({ jsonrpc: "2.0", method: "notifications/initialized" }).pipe(Effect.ignore);
  return yield* listAllTools(request);
});

/** JSON replies, or SSE streams whose `data:` lines carry the JSON-RPC messages. */
const messagesFromBody = (
  text: string,
  contentType: string | string[] | undefined,
): Array<Record<string, unknown>> => {
  const type = Array.isArray(contentType) ? contentType.join(";") : (contentType ?? "");
  if (type.includes("text/event-stream")) {
    return text.split("\n").flatMap((line) => {
      if (!line.startsWith("data:")) return [];
      const message = parseMessage(line.slice("data:".length).trim());
      return message === undefined ? [] : [message];
    });
  }
  const message = parseMessage(text);
  return message === undefined ? [] : [message];
};

/**
 * Connects to one configured MCP server and lists its tools. Every spawned process is scoped
 * to this call, so it is killed when the probe finishes or times out. A timeout, a failed
 * connection, or any unexpected error reports `down`; an HTTP 401/403 or an auth-shaped error
 * reports `needs-auth`. Never calls tools.
 */
export const probeMcpServer = (
  server: ConfiguredMcpServer,
  options: { readonly timeout?: Duration.Input } = {},
): Effect.Effect<
  McpProbeResult,
  never,
  ChildProcessSpawner.ChildProcessSpawner | HttpClient.HttpClient
> => {
  // Each stdio spawn is scoped on its own branch so the child is killed on timeout too.
  const transport: Effect.Effect<
    ReadonlyArray<McpProbeTool>,
    McpProbeFailure,
    ChildProcessSpawner.ChildProcessSpawner | HttpClient.HttpClient
  > = server.transport.type === "stdio"
    ? probeStdio(server.transport).pipe(Effect.scoped)
    : probeHttp(server.transport);
  return transport.pipe(
    Effect.timeoutOption(options.timeout ?? DEFAULT_TIMEOUT),
    Effect.map((result): McpProbeResult =>
      Option.match(result, {
        onNone: () => ({ status: "down" }),
        onSome: (tools) => ({ status: "ready", tools }),
      }),
    ),
    Effect.catch((failure) =>
      Effect.succeed<McpProbeResult>(
        failure.reason === "auth" ? { status: "needs-auth" } : { status: "down" },
      ),
    ),
    Effect.catchDefect(() => Effect.succeed<McpProbeResult>({ status: "down" })),
  );
};
