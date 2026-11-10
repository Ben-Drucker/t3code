// @effect-diagnostics globalFetch:off -- Read-only loopback probe at the BiDi Promise transport boundary.
// @effect-diagnostics nodeBuiltinImport:off -- lsof identifies the configured listener without inspecting profiles or signaling processes.
import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";

const exec = NodeUtil.promisify(NodeChildProcess.execFile);
export function firefoxBidiPort(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("T3CODE_FIREFOX_BIDI_PORT must be an integer from 1 to 65535.");
  return port;
}

export async function bidiPortStatus(
  port: number,
  firefoxPid?: number,
): Promise<string | undefined> {
  if (firefoxPid !== undefined) {
    const owner = await exec("lsof", ["-nP", "-a", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fp"], {
      timeout: 1_000,
      maxBuffer: 4096,
    }).then(
      (result) =>
        result.stdout
          .split("\n")
          .filter((line) => /^p\d+$/.test(line))
          .map((line) => Number(line.slice(1))),
      () => [] as number[],
    );
    if (owner.length > 0 && !owner.includes(firefoxPid))
      return `Firefox BiDi port ${port} is owned by another process. Choose a free T3CODE_FIREFOX_BIDI_PORT and restart Firefox with --remote-debugging-port=<that-port>.`;
  }
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(1_000),
    });
    if (response.ok) {
      const value = (await response.json()) as { Browser?: string };
      if (value.Browser?.match(/Chrome|Chromium|Edg\//i))
        return `Firefox BiDi port ${port} is owned by a Chromium browser. Choose a free port with T3CODE_FIREFOX_BIDI_PORT and restart Firefox with --remote-debugging-port=<that-port>.`;
    }
    if (response.status === 404) return undefined;
    return `Firefox BiDi port ${port} is occupied by a service that did not answer as Firefox. Choose a free port.`;
  } catch {
    return undefined;
  }
}
