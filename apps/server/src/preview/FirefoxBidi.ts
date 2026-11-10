// @effect-diagnostics globalTimers:off -- WebSocket callbacks own BiDi request deadlines.
import { MarionetteError } from "./MarionetteClient.ts";

interface Packet {
  id?: number;
  type?: string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: string;
}

/** Used only for capabilities Classic does not expose: prompt metadata, diagnostics, and media emulation. */
export class FirefoxBidi {
  private sequence = 0;
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (cause: unknown) => void }
  >();
  private readonly socket: WebSocket;
  readonly event: (method: string, params: Record<string, unknown>) => void;
  private constructor(
    socket: WebSocket,
    event: (method: string, params: Record<string, unknown>) => void,
  ) {
    this.socket = socket;
    this.event = event;
    socket.addEventListener("message", (message) => {
      try {
        const packet = JSON.parse(String(message.data)) as Packet;
        if (packet.id !== undefined) {
          const pending = this.pending.get(packet.id);
          this.pending.delete(packet.id);
          if (packet.type === "error")
            pending?.reject(
              new MarionetteError({
                code: packet.error ?? "unknown error",
                command: "BiDi",
                cause: packet,
              }),
            );
          else pending?.resolve(packet.result);
        } else if (packet.method && packet.params) event(packet.method, packet.params);
      } catch (cause) {
        this.close(cause);
      }
    });
    socket.addEventListener("close", () => this.close());
    socket.addEventListener("error", () => this.close());
  }

  static async connect(url: string, event: FirefoxBidi["event"]) {
    const endpoint = new URL(url);
    if (
      endpoint.protocol !== "ws:" ||
      !["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname)
    )
      throw new MarionetteError({ code: "invalid endpoint", command: "BiDi.connect" });
    const socket = new WebSocket(url);
    const client = new FirefoxBidi(socket, event);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        client.close();
        reject(new MarionetteError({ code: "timeout", command: "BiDi.connect" }));
      }, 5_000);
      socket.addEventListener(
        "open",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
      socket.addEventListener(
        "error",
        () => {
          clearTimeout(timer);
          reject(new MarionetteError({ code: "connection failed", command: "BiDi.connect" }));
        },
        { once: true },
      );
    });
    return client;
  }

  command(method: string, params: Record<string, unknown>) {
    return new Promise<unknown>((resolve, reject) => {
      const id = ++this.sequence;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new MarionetteError({ code: "timeout", command: method }));
      }, 5_000);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (cause) => {
          clearTimeout(timer);
          reject(cause);
        },
      });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close(cause: unknown = new MarionetteError({ code: "disconnected", command: "BiDi" })) {
    for (const pending of this.pending.values()) pending.reject(cause);
    this.pending.clear();
    if (this.socket.readyState < WebSocket.CLOSING) this.socket.close();
  }
}
