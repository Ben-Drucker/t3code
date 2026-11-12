import { parse as parseJsonc } from "jsonc-parser/lib/esm/main.js";
import { parse as parseToml } from "smol-toml";

export type ConfiguredMcpTransport =
  | {
      readonly type: "stdio";
      readonly command: string;
      readonly args: ReadonlyArray<string>;
      readonly env: Readonly<Record<string, string>>;
      readonly cwd: string | null;
    }
  | {
      readonly type: "http";
      readonly url: string;
      readonly headers: Readonly<Record<string, string>>;
    };

export interface ConfiguredMcpServer {
  readonly name: string;
  readonly transport: ConfiguredMcpTransport;
}

export interface McpConfigParseOptions {
  /** Expands `${VAR}` and `${VAR:-default}` references in values, as Claude Code does. */
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string | null;
}

const T3_SERVER_NAMES = new Set(["t3-code", "t3-code-direct"]);
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const asStringList = (value: unknown): ReadonlyArray<string> =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

const expandReferences = (value: string, env: NodeJS.ProcessEnv): string =>
  value.replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g,
    (_match, name: string, fallback) => {
      const resolved = env[name];
      if (resolved !== undefined && resolved !== "") return resolved;
      return fallback ?? "";
    },
  );

const stringRecord = (value: unknown, expand: (text: string) => string) => {
  const record = asRecord(value);
  if (record === undefined) return {};
  return Object.fromEntries(
    Object.entries(record).flatMap(([key, item]) =>
      typeof item === "string" ? [[key, expand(item)] as const] : [],
    ),
  );
};

const isT3Endpoint = (url: string) => {
  try {
    const parsed = new URL(url);
    return parsed.pathname === "/mcp" && LOOPBACK_HOSTS.has(parsed.hostname);
  } catch {
    return false;
  }
};

/** T3's own endpoint and entries are reported through the T3 source, never probed as user servers. */
const isT3ConfiguredServer = (server: ConfiguredMcpServer) =>
  T3_SERVER_NAMES.has(server.name) ||
  (server.transport.type === "http" && isT3Endpoint(server.transport.url));

/** Claude `mcpServers` entries: stdio when a command is set, otherwise HTTP or SSE by URL. */
const serversFromClaudeEntries = (
  entries: unknown,
  options: McpConfigParseOptions,
): ConfiguredMcpServer[] => {
  const record = asRecord(entries);
  if (record === undefined) return [];
  const expand = (text: string) => expandReferences(text, options.env);
  return Object.entries(record).flatMap(([name, value]): ConfiguredMcpServer[] => {
    const entry = asRecord(value);
    if (entry === undefined || entry.enabled === false) return [];
    const type = typeof entry.type === "string" ? entry.type : undefined;
    if (typeof entry.command === "string" && (type === undefined || type === "stdio")) {
      const cwd = typeof entry.cwd === "string" ? expand(entry.cwd) : options.cwd;
      return [
        {
          name,
          transport: {
            type: "stdio",
            command: expand(entry.command),
            args: asStringList(entry.args).map(expand),
            env: stringRecord(entry.env, expand),
            cwd,
          },
        },
      ];
    }
    if (
      typeof entry.url === "string" &&
      (type === undefined || type === "http" || type === "sse")
    ) {
      return [
        {
          name,
          transport: {
            type: "http",
            url: expand(entry.url),
            headers: stringRecord(entry.headers, expand),
          },
        },
      ];
    }
    return [];
  });
};

/** `.mcp.json` in the project and Kimi's `mcp.json`, both `{ "mcpServers": { ... } }`. */
export function parseMcpJsonFile(text: string, options: McpConfigParseOptions) {
  const root = asRecord(parseJsonc(text, [], { allowTrailingComma: true }));
  return serversFromClaudeEntries(root?.mcpServers, options);
}

/**
 * `~/.claude.json`: project-scoped servers for `options.cwd` come first, so they win over
 * top-level servers with the same name when the list is merged.
 */
export function parseClaudeUserConfig(text: string, options: McpConfigParseOptions) {
  const root = asRecord(parseJsonc(text, [], { allowTrailingComma: true }));
  if (root === undefined) return [];
  const projects = asRecord(root.projects);
  const project = options.cwd === null ? undefined : asRecord(projects?.[options.cwd]);
  return [
    ...serversFromClaudeEntries(project?.mcpServers, options),
    ...serversFromClaudeEntries(root.mcpServers, options),
  ];
}

/** `opencode.json(c)`: `mcp` maps names to `local` (command array) or `remote` (URL) entries. */
export function parseOpenCodeConfig(text: string, options: McpConfigParseOptions) {
  const root = asRecord(parseJsonc(text, [], { allowTrailingComma: true }));
  const entries = asRecord(root?.mcp);
  if (entries === undefined) return [];
  const expand = (value: string) => expandReferences(value, options.env);
  return Object.entries(entries).flatMap(([name, value]): ConfiguredMcpServer[] => {
    const entry = asRecord(value);
    if (entry === undefined || entry.enabled === false) return [];
    if (entry.type === "local") {
      const [command, ...args] = asStringList(entry.command);
      if (command === undefined) return [];
      return [
        {
          name,
          transport: {
            type: "stdio",
            command: expand(command),
            args: args.map(expand),
            env: stringRecord(entry.environment, expand),
            cwd: options.cwd,
          },
        },
      ];
    }
    if (entry.type === "remote" && typeof entry.url === "string") {
      return [
        {
          name,
          transport: {
            type: "http",
            url: expand(entry.url),
            headers: stringRecord(entry.headers, expand),
          },
        },
      ];
    }
    return [];
  });
}

/**
 * `[mcp_servers.<name>]` in Codex's `config.toml`. `env_http_headers` maps a header to an
 * environment variable whose value is passed to that server; `bearer_token_env_var` likewise.
 */
export function parseCodexConfigToml(text: string, options: McpConfigParseOptions) {
  let root: Record<string, unknown>;
  try {
    root = parseToml(text) as Record<string, unknown>;
  } catch {
    return [];
  }
  const entries = asRecord(root.mcp_servers);
  if (entries === undefined) return [];
  const expand = (value: string) => expandReferences(value, options.env);
  return Object.entries(entries).flatMap(([name, value]): ConfiguredMcpServer[] => {
    const entry = asRecord(value);
    if (entry === undefined || entry.enabled === false) return [];
    if (typeof entry.command === "string") {
      return [
        {
          name,
          transport: {
            type: "stdio",
            command: expand(entry.command),
            args: asStringList(entry.args).map(expand),
            env: stringRecord(entry.env, expand),
            cwd: typeof entry.cwd === "string" ? expand(entry.cwd) : options.cwd,
          },
        },
      ];
    }
    if (typeof entry.url === "string") {
      const headers: Record<string, string> = stringRecord(entry.http_headers, expand);
      const envHeaders = asRecord(entry.env_http_headers);
      for (const [header, variable] of Object.entries(envHeaders ?? {})) {
        const resolved = typeof variable === "string" ? options.env[variable] : undefined;
        if (resolved !== undefined) headers[header] = resolved;
      }
      if (typeof entry.bearer_token_env_var === "string") {
        const token = options.env[entry.bearer_token_env_var];
        if (token !== undefined) headers.Authorization = `Bearer ${token}`;
      }
      return [{ name, transport: { type: "http", url: expand(entry.url), headers } }];
    }
    return [];
  });
}

/** First occurrence of a name wins, so callers list the most specific source first. */
export function mergeConfiguredMcpServers(
  lists: ReadonlyArray<ReadonlyArray<ConfiguredMcpServer>>,
): ConfiguredMcpServer[] {
  const byName = new Map<string, ConfiguredMcpServer>();
  for (const server of lists.flat()) {
    if (isT3ConfiguredServer(server) || byName.has(server.name)) continue;
    byName.set(server.name, server);
  }
  return [...byName.values()].toSorted((left, right) => left.name.localeCompare(right.name));
}
