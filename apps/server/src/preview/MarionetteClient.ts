// @effect-diagnostics nodeBuiltinImport:off globalTimers:off -- TCP callbacks own protocol framing and deadlines.
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as NodeNet from "node:net";

export class MarionetteError extends Schema.TaggedError<MarionetteError>()("MarionetteError", {
  code: Schema.String,
  command: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message() {
    if (this.code === "session already active")
      return "Firefox already has an active automation session. End it with session.end (or stop the other automation client) before retrying. If that client exited without ending its session, restart Firefox.";
    return `Firefox Marionette ${this.command} failed (${this.code}).`;
  }
}

interface Options {
  readonly port?: number;
  readonly timeoutMs?: number;
}

const MAX_FRAME_BYTES = 32 * 1024 * 1024;

/** The Promise adapter owns a single sequential Marionette transport, never a Firefox process. */
export class MarionetteConnection {
  private socket: NodeNet.Socket | undefined;
  private buffer = Buffer.alloc(0);
  private sequence = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private receiver:
    | { resolve: (value: unknown) => void; reject: (cause: unknown) => void }
    | undefined;
  private failure: unknown;
  private session = false;
  private closed = false;
  webSocketUrl: string | undefined;
  platformName = "";
  processId: number | undefined;
  readonly options: Options;

  constructor(options: Options = {}) {
    this.options = options;
  }

  get connected() {
    return this.session && !this.closed && this.failure === undefined;
  }

  private fail(cause: unknown) {
    this.failure = cause;
    this.session = false;
    this.receiver?.reject(cause);
    this.receiver = undefined;
    this.socket?.destroy();
  }

  private receive(chunk: Buffer) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    try {
      for (;;) {
        const colon = this.buffer.indexOf(58);
        if (colon === -1) {
          if (this.buffer.length > 9) throw new Error("Invalid Marionette frame length");
          return;
        }
        const header = this.buffer.subarray(0, colon).toString("ascii");
        if (!/^\d{1,9}$/.test(header)) throw new Error("Invalid Marionette frame length");
        const length = Number(header);
        if (length < 2 || length > MAX_FRAME_BYTES)
          throw new Error("Marionette frame exceeds limit");
        if (this.buffer.length < colon + 1 + length) return;
        const packet: unknown = JSON.parse(
          this.buffer.subarray(colon + 1, colon + 1 + length).toString("utf8"),
        );
        this.buffer = this.buffer.subarray(colon + 1 + length);
        const receiver = this.receiver;
        if (!receiver) throw new Error("Unsolicited Marionette packet");
        this.receiver = undefined;
        receiver.resolve(packet);
      }
    } catch (cause) {
      this.fail(new MarionetteError({ code: "invalid response", command: "receive", cause }));
    }
  }

  private packet(command: string, write?: () => void): Promise<unknown> {
    if (this.failure !== undefined) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => this.fail(new MarionetteError({ code: "timeout", command })),
        this.options.timeoutMs ?? 20_000,
      );
      this.receiver = {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (cause) => {
          clearTimeout(timer);
          reject(cause);
        },
      };
      write?.();
    });
  }

  private async send(command: string, parameters: Record<string, unknown>) {
    const id = ++this.sequence;
    const data = Buffer.from(JSON.stringify([0, id, command, parameters]), "utf8");
    if (data.length > MAX_FRAME_BYTES)
      throw new MarionetteError({ code: "request too large", command });
    const response = await this.packet(command, () =>
      this.socket!.write(Buffer.concat([Buffer.from(`${data.length}:`), data])),
    );
    if (
      !Array.isArray(response) ||
      response.length !== 4 ||
      response[0] !== 1 ||
      response[1] !== id
    ) {
      const error = new MarionetteError({ code: "invalid response", command });
      this.fail(error);
      throw error;
    }
    if (response[2] !== null) {
      const remote = response[2] as { error?: unknown; message?: unknown };
      throw new MarionetteError({
        code:
          typeof remote?.message === "string" &&
          /Maximum number of active sessions|already.*session/i.test(remote.message)
            ? "session already active"
            : typeof remote?.error === "string"
              ? remote.error
              : "unknown error",
        command,
        cause: response[2],
      });
    }
    return response[3] as unknown;
  }

  private enqueue<A>(run: () => Promise<A>): Promise<A> {
    const pending = this.queue.then(run);
    this.queue = pending.catch(() => undefined);
    return pending;
  }

  connect() {
    return this.enqueue(async () => {
      if (this.connected) return;
      if (this.closed) throw new MarionetteError({ code: "closed", command: "connect" });
      this.failure = undefined;
      this.buffer = Buffer.alloc(0);
      this.socket?.destroy();
      const socket = NodeNet.createConnection({
        host: "127.0.0.1",
        port: this.options.port ?? 2828,
      });
      this.socket = socket;
      socket.on("data", (chunk: Buffer) => {
        if (this.socket === socket) this.receive(chunk);
      });
      socket.on("error", (cause) => {
        if (this.socket === socket)
          this.fail(new MarionetteError({ code: "connection failed", command: "connect", cause }));
      });
      socket.on("close", () => {
        if (this.socket === socket)
          this.fail(new MarionetteError({ code: "disconnected", command: "receive" }));
      });
      const greeting = (await this.packet("handshake")) as {
        marionetteProtocol?: unknown;
        applicationType?: unknown;
      };
      if (
        greeting === null ||
        typeof greeting !== "object" ||
        greeting.marionetteProtocol !== 3 ||
        greeting.applicationType !== "gecko"
      ) {
        const error = new MarionetteError({ code: "unsupported protocol", command: "handshake" });
        this.fail(error);
        throw error;
      }
      const result = (await this.send("WebDriver:NewSession", {
        pageLoadStrategy: "normal",
        unhandledPromptBehavior: "ignore",
        webSocketUrl: true,
      }).catch((cause) => {
        this.fail(cause);
        throw cause;
      })) as {
        sessionId?: string;
        capabilities?: { webSocketUrl?: string; platformName?: string; "moz:processID"?: number };
      };
      if (typeof result?.sessionId !== "string" || !result.capabilities) {
        const error = new MarionetteError({
          code: "invalid response",
          command: "WebDriver:NewSession",
        });
        this.fail(error);
        throw error;
      }
      this.webSocketUrl = result.capabilities?.webSocketUrl;
      this.platformName = result.capabilities?.platformName ?? "";
      this.processId = result.capabilities?.["moz:processID"];
      this.session = true;
    });
  }

  command(command: string, parameters: Record<string, unknown> = {}) {
    return this.enqueue(async () => {
      if (!this.connected) throw new MarionetteError({ code: "invalid session id", command });
      return this.send(command, parameters);
    });
  }

  close() {
    return this.enqueue(async () => {
      if (this.closed) return;
      try {
        if (this.connected) await this.send("WebDriver:DeleteSession", {});
      } finally {
        this.closed = true;
        this.session = false;
        this.socket?.destroy();
      }
    });
  }
}

export class MarionetteClient extends Context.Service<
  MarionetteClient,
  {
    readonly connection: (
      options: Options,
    ) => Effect.Effect<MarionetteConnection, never, import("effect/Scope").Scope>;
  }
>()("t3/preview/MarionetteClient") {}

export const layer = Layer.succeed(MarionetteClient, {
  connection: Effect.fn("MarionetteClient.connection")(function* (options) {
    return yield* Effect.acquireRelease(
      Effect.sync(() => new MarionetteConnection(options)),
      (connection) => Effect.promise(() => connection.close()).pipe(Effect.ignore),
    );
  }),
});
