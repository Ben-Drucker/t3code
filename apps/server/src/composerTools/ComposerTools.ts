import type {
  ComposerToolEntry,
  ComposerToolGroup,
  ComposerToolsListInput,
  ComposerToolsSnapshot,
  ProviderDriverKind,
  ThreadId,
} from "@t3tools/contracts";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import type * as HttpClient from "effect/http/HttpClient";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as McpHttpServer from "../mcp/McpHttpServer.ts";
import { CLAUDE_PROVIDER } from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import { CODEX_DRIVER_KIND } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { resolveClaudeHomePath } from "../provider/Drivers/ClaudeHome.ts";
import {
  mergeConfiguredMcpServers,
  parseClaudeUserConfig,
  parseCodexConfigToml,
  parseMcpJsonFile,
  parseOpenCodeConfig,
  type ConfiguredMcpServer,
  type McpConfigParseOptions,
} from "./mcpConfigFiles.ts";
import { probeMcpServer, type McpProbeResult } from "./mcpServerProbe.ts";
import {
  claudeDeferredToolNames,
  codexAdditionalTools,
  splitClaudeMcpToolName,
} from "./transcriptTools.ts";

type Snapshot = ComposerToolsSnapshot;
type Group = ComposerToolGroup;
type Entry = ComposerToolEntry;

export class ComposerTools extends Context.Service<
  ComposerTools,
  {
    /** Emits the whole list when the menu opens and again as each server reports. */
    readonly list: (input: ComposerToolsListInput) => Stream.Stream<Snapshot>;
  }
>()("t3/composerTools/ComposerTools") {}

// Ids come from the thread record; anything that could escape the transcript directories is refused.
const SAFE_ID = /^[A-Za-z0-9_-]+$/;

const codexRolloutName = (threadId: string) =>
  new RegExp(`-${threadId}(?:_[0-9a-f-]+)?\\.jsonl$`, "i");

const sortEntries = (entries: ReadonlyArray<Entry>): Entry[] => {
  const byName = new Map<string, Entry>();
  for (const entry of entries) if (!byName.has(entry.name)) byName.set(entry.name, entry);
  return [...byName.values()].toSorted((left, right) => left.name.localeCompare(right.name));
};

const groupRank = (group: Group) => (group.kind === "t3" ? 0 : group.kind === "provider" ? 1 : 2);

const sortGroups = (groups: ReadonlyArray<Group>): Group[] =>
  [...groups].toSorted(
    (left, right) => groupRank(left) - groupRank(right) || left.source.localeCompare(right.source),
  );

/** Claude replaces characters outside `[A-Za-z0-9_-]` with `_` when it names MCP tools. */
const claudeServerKey = (server: string) => server.replace(/[^A-Za-z0-9_-]/g, "_");

const applyProbe = (
  groups: ReadonlyArray<Group>,
  server: ConfiguredMcpServer,
  result: McpProbeResult,
): Group[] =>
  groups.map((group) => {
    if (group.kind !== "mcp" || group.source !== server.name) return group;
    if (result.status !== "ready") return { ...group, status: result.status };
    return {
      ...group,
      status: "ready",
      tools: sortEntries([...result.tools, ...group.tools]),
    };
  });

const make = Effect.gen(function* () {
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* HostProcess.HomeDirectory;
  const t3Tools = yield* McpHttpServer.t3ToolSummaries;
  // Captured once so the stream the RPC returns needs nothing from its caller.
  const services = yield* Effect.context<
    | ChildProcessSpawner.ChildProcessSpawner
    | HttpClient.HttpClient
    | FileSystem.FileSystem
    | Path.Path
    | ThreadManagementService.ThreadManagementService
  >();

  const readText = (file: string) =>
    fileSystem.readFileString(file).pipe(Effect.option, Effect.map(Option.getOrUndefined));

  const codexHomeFor = (env: NodeJS.ProcessEnv) =>
    env.CODEX_HOME ? expandHomePath(env.CODEX_HOME, home) : path.join(home, ".codex");

  const readConfiguredServers = Effect.fn("ComposerTools.readConfiguredServers")(function* (
    cwd: string | null,
    env: NodeJS.ProcessEnv,
  ) {
    const options: McpConfigParseOptions = { env, cwd };
    const opencodeHome = path.join(env.XDG_CONFIG_HOME ?? path.join(home, ".config"), "opencode");
    // Project files first; the first source to name a server wins when merged.
    const sources: ReadonlyArray<{
      readonly file: string;
      readonly parse: (text: string, options: McpConfigParseOptions) => ConfiguredMcpServer[];
    }> = [
      ...(cwd === null
        ? []
        : [
            { file: path.join(cwd, ".mcp.json"), parse: parseMcpJsonFile },
            { file: path.join(cwd, "opencode.json"), parse: parseOpenCodeConfig },
            { file: path.join(cwd, "opencode.jsonc"), parse: parseOpenCodeConfig },
          ]),
      { file: path.join(home, ".claude.json"), parse: parseClaudeUserConfig },
      { file: path.join(codexHomeFor(env), "config.toml"), parse: parseCodexConfigToml },
      { file: path.join(opencodeHome, "opencode.json"), parse: parseOpenCodeConfig },
      { file: path.join(opencodeHome, "opencode.jsonc"), parse: parseOpenCodeConfig },
      { file: path.join(home, ".kimi-code", "mcp.json"), parse: parseMcpJsonFile },
      { file: path.join(home, ".kimi", "mcp.json"), parse: parseMcpJsonFile },
    ];
    const lists: ConfiguredMcpServer[][] = [];
    for (const source of sources) {
      const text = yield* readText(source.file);
      if (text !== undefined) lists.push(source.parse(text, options));
    }
    return mergeConfiguredMcpServers(lists);
  });

  const claudeTranscriptLines = Effect.fn("ComposerTools.claudeTranscriptLines")(function* (
    nativeId: string,
    env: NodeJS.ProcessEnv,
  ) {
    if (!SAFE_ID.test(nativeId)) return undefined;
    const claudeHome = yield* resolveClaudeHomePath({ homePath: "" }, env);
    const projectsDir = path.join(claudeHome, "projects");
    const projects = yield* fileSystem
      .readDirectory(projectsDir)
      .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
    for (const project of projects) {
      const text = yield* readText(path.join(projectsDir, project, `${nativeId}.jsonl`));
      if (text !== undefined) return text.split("\n");
    }
    return undefined;
  });

  // Rollouts sit in sessions/YYYY/MM/DD. The newest name match is the one the thread writes now.
  const codexRolloutLines = Effect.fn("ComposerTools.codexRolloutLines")(function* (
    threadId: string,
    env: NodeJS.ProcessEnv,
  ) {
    if (!SAFE_ID.test(threadId)) return undefined;
    const matcher = codexRolloutName(threadId);
    const matches: Array<{ readonly file: string; readonly mtime: number }> = [];
    // Depth 0 lists YYYY, 1 MM, 2 DD, 3 the rollout files. Reading a file as a directory fails
    // quietly, so only the file level needs a stat.
    const walk: (dir: string, depth: number) => Effect.Effect<void> = Effect.fn(
      "ComposerTools.walkCodexRollouts",
    )(function* (dir: string, depth: number) {
      const entries = yield* fileSystem
        .readDirectory(dir)
        .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
      for (const entry of entries) {
        const full = path.join(dir, entry);
        if (depth < 3) {
          yield* walk(full, depth + 1);
        } else if (matcher.test(entry)) {
          const info = yield* fileSystem.stat(full).pipe(Effect.option);
          const mtime = Option.isSome(info) ? Option.getOrUndefined(info.value.mtime) : undefined;
          matches.push({ file: full, mtime: mtime?.getTime() ?? 0 });
        }
      }
    });
    yield* walk(path.join(codexHomeFor(env), "sessions"), 0);
    const newest = matches.toSorted((left, right) => right.mtime - left.mtime)[0];
    if (newest === undefined) return undefined;
    const text = yield* readText(newest.file);
    return text?.split("\n");
  });

  const nativeIdFor = Effect.fn("ComposerTools.nativeIdFor")(function* (
    threadId: ThreadId | null,
    driver: ProviderDriverKind | null,
  ) {
    if (threadId === null || driver === null) return null;
    const records = yield* threads
      .getThreadRecords(threadId, ["providerThreads"])
      .pipe(Effect.option);
    if (Option.isNone(records)) return null;
    const providerThread = records.value.providerThreads.find(
      (candidate) => candidate.driver === driver && candidate.nativeThreadRef !== null,
    );
    return providerThread?.nativeThreadRef?.nativeId ?? null;
  });

  const planList = Effect.fn("ComposerTools.list")(function* (input: ComposerToolsListInput) {
    const env = process.env;
    const nativeId = yield* nativeIdFor(input.threadId, input.driver);

    // What the session itself reports, so it needs a session id, not a probe.
    let providerGroup: Group | undefined;
    const mcpToolsFromSession: Array<{ readonly server: string; readonly tool: string }> = [];
    if (nativeId !== null && input.driver === CLAUDE_PROVIDER) {
      const lines = yield* claudeTranscriptLines(nativeId, env);
      if (lines !== undefined) {
        const names = claudeDeferredToolNames(lines);
        const tools: Entry[] = [];
        for (const name of names) {
          const mcp = splitClaudeMcpToolName(name);
          if (mcp === null) tools.push({ name, description: null });
          else mcpToolsFromSession.push(mcp);
        }
        providerGroup = {
          source: "Claude",
          kind: "provider",
          status: "ready",
          tools: sortEntries(tools),
        };
      }
    } else if (nativeId !== null && input.driver === CODEX_DRIVER_KIND) {
      const lines = yield* codexRolloutLines(nativeId, env);
      if (lines !== undefined) {
        providerGroup = {
          source: "Codex",
          kind: "provider",
          status: "ready",
          tools: sortEntries(codexAdditionalTools(lines)),
        };
      }
    }

    const configured = yield* readConfiguredServers(input.cwd, env);
    const mcpGroups = new Map<string, Group>();
    const groupFor = (server: string): Group => {
      const existing = mcpGroups.get(server);
      if (existing !== undefined) return existing;
      const created: Group = { source: server, kind: "mcp", status: "ready", tools: [] };
      mcpGroups.set(server, created);
      return created;
    };
    // Configured servers start as "checking" and are probed; tools the session already loaded
    // stay visible under their server whatever the probe says.
    for (const server of configured) {
      mcpGroups.set(server.name, {
        source: server.name,
        kind: "mcp",
        status: "checking",
        tools: [],
      });
    }
    for (const item of mcpToolsFromSession) {
      const key = [...mcpGroups.keys()].find(
        (name) => claudeServerKey(name) === claudeServerKey(item.server),
      );
      const group = groupFor(key ?? item.server);
      mcpGroups.set(group.source, {
        ...group,
        tools: sortEntries([...group.tools, { name: item.tool, description: null }]),
      });
    }

    const initial: Group[] = [
      { source: "T3", kind: "t3", status: "ready", tools: sortEntries(t3Tools) },
      ...(providerGroup === undefined ? [] : [providerGroup]),
      ...mcpGroups.values(),
    ];
    const state = yield* Ref.make<ReadonlyArray<Group>>(initial);
    const probes = Stream.fromIterable(configured).pipe(
      Stream.mapEffect(
        (server) =>
          probeMcpServer(server).pipe(
            Effect.provideContext(services),
            Effect.flatMap((result) =>
              Ref.updateAndGet(state, (groups) => applyProbe(groups, server, result)),
            ),
          ),
        { concurrency: "unbounded" },
      ),
    );
    return Stream.make(sortGroups(initial)).pipe(
      Stream.concat(probes.pipe(Stream.map(sortGroups))),
      Stream.map((groups): Snapshot => ({ groups })),
    );
  });

  return ComposerTools.of({
    list: (input) => Stream.unwrap(planList(input).pipe(Effect.provideContext(services))),
  });
});

export const layer = Layer.effect(ComposerTools, make);
