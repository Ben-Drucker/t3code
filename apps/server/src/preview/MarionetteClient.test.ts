import { expect, it, vi } from "vite-plus/test";
import * as NodeNet from "node:net";
import { MarionetteConnection } from "./MarionetteClient.ts";

const frame = (value: unknown) => {
  const data = Buffer.from(JSON.stringify(value));
  return Buffer.concat([Buffer.from(`${data.length}:`), data]);
};

const fixture = async (
  handle: (
    command: string,
    parameters: Record<string, unknown>,
    reply: (result: unknown, error?: unknown) => void,
    socket: NodeNet.Socket,
  ) => void,
  options: { greeting?: unknown; sessionError?: boolean | "active" } = {},
) => {
  const sockets = new Set<NodeNet.Socket>();
  const commands: string[] = [];
  const server = NodeNet.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.write(frame(options.greeting ?? { applicationType: "gecko", marionetteProtocol: 3 }));
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        const colon = buffer.indexOf(58);
        if (colon < 0) return;
        const length = Number(buffer.subarray(0, colon).toString());
        if (buffer.length < colon + 1 + length) return;
        const [, id, command, parameters] = JSON.parse(
          buffer.subarray(colon + 1, colon + 1 + length).toString(),
        ) as [number, number, string, Record<string, unknown>];
        buffer = buffer.subarray(colon + 1 + length);
        commands.push(command);
        const reply = (result: unknown, error: unknown = null) =>
          socket.write(frame([1, id, error, result]));
        if (command === "WebDriver:NewSession") {
          expect(parameters).toEqual({
            pageLoadStrategy: "normal",
            unhandledPromptBehavior: "ignore",
            webSocketUrl: true,
          });
          if (options.sessionError)
            reply(null, {
              error: "session not created",
              message:
                options.sessionError === "active"
                  ? "Maximum number of active sessions"
                  : "private session details",
              stacktrace: "",
            });
          else reply({ sessionId: "test", capabilities: {} });
        } else if (command === "WebDriver:DeleteSession") reply(null);
        else handle(command, parameters, reply, socket);
      }
    });
  });
  server.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address() as NodeNet.AddressInfo;
  const connection = new MarionetteConnection({ port: address.port, timeoutMs: 500 });
  return {
    connection,
    commands,
    async [Symbol.asyncDispose]() {
      await connection.close();
      for (const socket of sockets) socket.destroy();
      server.close();
      await new Promise<void>((resolve) => server.once("close", resolve));
    },
  };
};

it("frames Unicode by UTF-8 bytes, accepts split replies, and ends only its session", async () => {
  await using server = await fixture((_command, parameters, _reply, socket) => {
    expect(parameters).toEqual({ text: "héllo 🦊" });
    const response = frame([1, 2, null, { value: "🦊" }]);
    socket.write(response.subarray(0, 4));
    socket.write(response.subarray(4, 13));
    socket.write(response.subarray(13));
  });
  await server.connection.connect();
  expect(await server.connection.command("echo", { text: "héllo 🦊" })).toEqual({ value: "🦊" });
});

it("serializes concurrent commands and retains the session after a remote error", async () => {
  let release: (() => void) | undefined;
  let arrived: (() => void) | undefined;
  const firstArrived = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  await using server = await fixture((command, _parameters, reply) => {
    if (command === "first") {
      release = () => reply({ value: 1 });
      arrived!();
    } else if (command === "fail")
      reply(null, { error: "invalid selector", message: "private details", stacktrace: "" });
    else reply({ value: 2 });
  });
  await server.connection.connect();
  const first = server.connection.command("first");
  const second = server.connection.command("second");
  await firstArrived;
  expect(server.commands).toEqual(["WebDriver:NewSession", "first"]);
  release!();
  expect(await Promise.all([first, second])).toEqual([{ value: 1 }, { value: 2 }]);
  await expect(server.connection.command("fail")).rejects.toMatchObject({
    code: "invalid selector",
    command: "fail",
  });
  expect(server.connection.connected).toBe(true);
  await server.connection.close();
  await server.connection.close();
  expect(server.commands).toEqual([
    "WebDriver:NewSession",
    "first",
    "second",
    "fail",
    "WebDriver:DeleteSession",
  ]);
  await expect(server.connection.command("after")).rejects.toMatchObject({
    code: "invalid session id",
  });
});

it("rejects a mismatched response and reconnects without replaying the failed command", async () => {
  await using server = await fixture((command, _parameters, reply, socket) => {
    if (command === "bad") socket.write(frame([1, 999, null, {}]));
    else reply({ value: true });
  });
  await server.connection.connect();
  await expect(server.connection.command("bad")).rejects.toMatchObject({
    code: "invalid response",
  });
  expect(server.connection.connected).toBe(false);
  await server.connection.connect();
  expect(await server.connection.command("good")).toEqual({ value: true });
  expect(server.commands.filter((command) => command === "bad")).toHaveLength(1);
  expect(server.commands.filter((command) => command === "WebDriver:NewSession")).toHaveLength(2);
});

it.each(["x:[]", "999999999:", "2:{x"])("rejects malformed framing %s", async (data) => {
  await using server = await fixture((_command, _parameters, _reply, socket) => socket.write(data));
  await server.connection.connect();
  await expect(server.connection.command("bad")).rejects.toMatchObject({
    code: "invalid response",
  });
});

it("rejects an in-flight command on disconnect, without retrying mutations", async () => {
  await using server = await fixture((_command, _parameters, _reply, socket) => socket.destroy());
  await server.connection.connect();
  await expect(server.connection.command("click")).rejects.toMatchObject({ code: "disconnected" });
  expect(server.commands).toEqual(["WebDriver:NewSession", "click"]);
});

it.each([
  { applicationType: "gecko", marionetteProtocol: 2 },
  { applicationType: "other", marionetteProtocol: 3 },
])("rejects unsupported greetings %j", async (greeting) => {
  await using server = await fixture(() => {}, { greeting });
  await expect(server.connection.connect()).rejects.toMatchObject({ code: "unsupported protocol" });
  expect(server.commands).toEqual([]);
});

it.each([true, "active"] as const)(
  "retains typed session failures and closes a failed acquisition (%s)",
  async (sessionError) => {
    await using server = await fixture(() => {}, { sessionError });
    await expect(server.connection.connect()).rejects.toMatchObject({
      code: sessionError === "active" ? "session already active" : "session not created",
      command: "WebDriver:NewSession",
    });
    expect(server.connection.connected).toBe(false);
    await server.connection.close();
    expect(server.commands).toEqual(["WebDriver:NewSession"]);
  },
);

it("rejects a truncated frame when the peer closes the connection", async () => {
  await using server = await fixture((_command, _parameters, _reply, socket) =>
    socket.end("100:[1,"),
  );
  await server.connection.connect();
  await expect(server.connection.command("truncated")).rejects.toMatchObject({
    code: "disconnected",
  });
});

it("disconnects an expired command and rejects queued work without replay", async () => {
  const arrived = Promise.withResolvers<void>();
  await using server = await fixture(() => arrived.resolve());
  await server.connection.connect();
  vi.useFakeTimers();
  try {
    const first = expect(server.connection.command("blocked")).rejects.toMatchObject({
      code: "timeout",
      command: "blocked",
    });
    const next = expect(server.connection.command("queued")).rejects.toMatchObject({
      code: "invalid session id",
    });
    await arrived.promise;
    await vi.advanceTimersByTimeAsync(500);
    await Promise.all([first, next]);
    expect(server.commands).toEqual(["WebDriver:NewSession", "blocked"]);
    expect(server.connection.connected).toBe(false);
  } finally {
    vi.useRealTimers();
  }
});
