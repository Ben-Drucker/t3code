import { describe, expect, it } from "vite-plus/test";

import {
  mergeConfiguredMcpServers,
  parseClaudeUserConfig,
  parseCodexConfigToml,
  parseMcpJsonFile,
  parseOpenCodeConfig,
} from "./mcpConfigFiles.ts";

const options = { env: { API_TOKEN: "secret-value" }, cwd: "/work/project" };

describe("MCP config files", () => {
  it("reads .mcp.json entries as stdio or HTTP and expands references", () => {
    const servers = parseMcpJsonFile(
      JSON.stringify({
        mcpServers: {
          playwright: { command: "npx", args: ["@playwright/mcp"], env: { MODE: "x" } },
          docs: {
            type: "http",
            url: "https://docs.example/mcp",
            headers: { "X-Key": "${API_TOKEN}" },
          },
          off: { command: "node", enabled: false },
        },
      }),
      options,
    );

    expect(servers).toEqual([
      {
        name: "playwright",
        transport: {
          type: "stdio",
          command: "npx",
          args: ["@playwright/mcp"],
          env: { MODE: "x" },
          cwd: "/work/project",
        },
      },
      {
        name: "docs",
        transport: {
          type: "http",
          url: "https://docs.example/mcp",
          headers: { "X-Key": "secret-value" },
        },
      },
    ]);
  });

  it("puts a project's own servers in ~/.claude.json ahead of top-level ones", () => {
    const text = JSON.stringify({
      mcpServers: { shared: { command: "top" }, global: { command: "g" } },
      projects: { "/work/project": { mcpServers: { shared: { command: "project" } } } },
    });

    const servers = parseClaudeUserConfig(text, options);
    const merged = mergeConfiguredMcpServers([servers]);

    expect(merged.map((server) => [server.name, server.transport])).toEqual([
      ["global", expect.objectContaining({ command: "g" })],
      ["shared", expect.objectContaining({ command: "project" })],
    ]);
  });

  it("reads Codex mcp_servers tables, including env header references and disabled entries", () => {
    const servers = parseCodexConfigToml(
      [
        "[mcp_servers.linear]",
        'url = "https://mcp.linear.app/mcp"',
        'bearer_token_env_var = "API_TOKEN"',
        "",
        "[mcp_servers.local]",
        'command = "uvx"',
        'args = ["serve"]',
        "[mcp_servers.local.env]",
        'MODE = "fast"',
        "",
        "[mcp_servers.paused]",
        'command = "x"',
        "enabled = false",
      ].join("\n"),
      options,
    );

    expect(servers).toEqual([
      {
        name: "linear",
        transport: {
          type: "http",
          url: "https://mcp.linear.app/mcp",
          headers: { Authorization: "Bearer secret-value" },
        },
      },
      {
        name: "local",
        transport: {
          type: "stdio",
          command: "uvx",
          args: ["serve"],
          env: { MODE: "fast" },
          cwd: "/work/project",
        },
      },
    ]);
  });

  it("reads OpenCode local and remote entries from JSONC with comments", () => {
    const servers = parseOpenCodeConfig(
      `{
        // project servers
        "mcp": {
          "files": { "type": "local", "command": ["bunx", "files-mcp", "--root", "."], },
          "remote": { "type": "remote", "url": "https://remote.example/mcp" },
        },
      }`,
      options,
    );

    expect(servers.map((server) => [server.name, server.transport.type])).toEqual([
      ["files", "stdio"],
      ["remote", "http"],
    ]);
    expect(servers[0]?.transport).toMatchObject({
      command: "bunx",
      args: ["files-mcp", "--root", "."],
    });
  });

  it("skips T3's own endpoint and the t3-code entries before they are probed", () => {
    const servers = [
      ...parseMcpJsonFile(
        JSON.stringify({
          mcpServers: {
            "t3-code": { command: "t3" },
            "t3-code-direct": { command: "t3" },
            self: { type: "http", url: "http://127.0.0.1:3773/mcp" },
            other: { type: "http", url: "https://example.com/mcp" },
          },
        }),
        options,
      ),
    ];

    expect(mergeConfiguredMcpServers([servers]).map((server) => server.name)).toEqual(["other"]);
  });

  it("returns nothing for unreadable config text", () => {
    expect(parseMcpJsonFile("{ not json", options)).toEqual([]);
    expect(parseCodexConfigToml("[mcp_servers.x", options)).toEqual([]);
  });
});
