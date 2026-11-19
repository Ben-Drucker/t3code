import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  type OrchestrationV2DomainEvent,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type RuntimeMode,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as TerminalCommandService from "./TerminalCommandService.ts";

const instanceId = ProviderInstanceId.make("antigravity");
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("antigravity"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("unused in TerminalCommandService tests"),
} as ProviderAdapter.ProviderAdapterV2["Service"];

const awaitDomainEvent = <E extends OrchestrationV2DomainEvent>(
  orchestrator: Orchestrator.OrchestratorV2["Service"],
  match: (event: OrchestrationV2DomainEvent) => event is E,
) =>
  orchestrator.streamStoredEventsFrom({ afterSequence: 0 }).pipe(
    Stream.map((stored) => stored.event),
    Stream.filter(match),
    Stream.runHead,
    Effect.flatMap(
      Option.match({ onNone: () => Effect.die("stream ended"), onSome: Effect.succeed }),
    ),
  );

const makeTestLayer = (workspaceRoot: string, foregroundTimeoutMs = 50) => {
  const databaseLayer = SqlitePersistence.layerMemory;
  const orchestratorHarness = ProviderReplayHarness.layerWithRegistry(
    { name: "terminal-command-service" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer, runEffectWorker: false },
  );
  const projectLayer = Layer.mock(ProjectService.ProjectService)({
    getById: (id) =>
      Effect.succeedSome({
        id,
        title: "Terminal Test Project",
        workspaceRoot,
        defaultModelSelection: { instanceId, model: "gemini-2.5-pro" },
        scripts: [],
        createdAt: "2026-11-15T00:00:00.000Z",
        updatedAt: "2026-11-15T00:00:00.000Z",
        deletedAt: null,
      } as never),
  });
  return Layer.mergeAll(
    orchestratorHarness,
    ProjectionStore.layer.pipe(Layer.provide(databaseLayer)),
    projectLayer,
    Layer.effect(
      TerminalCommandService.TerminalCommandService,
      TerminalCommandService.makeWithOptions({ foregroundTimeoutMs }),
    ).pipe(Layer.provide(orchestratorHarness), Layer.provide(projectLayer)),
  ).pipe(Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)));
};

const seedRunningThread = Effect.fn("seedRunningThread")(function* (
  suffix: string,
  runtimeMode: RuntimeMode = "auto",
) {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projectId = ProjectId.make(`project-terminal-${suffix}`);
  const threadId = ThreadId.make(`thread-terminal-${suffix}`);
  const messageId = MessageId.make(`message-terminal-${suffix}`);

  yield* orchestrator.dispatch({
    type: "thread.create",
    commandId: CommandId.make(`cmd-create-${suffix}`),
    threadId,
    projectId,
    title: `Terminal ${suffix}`,
    modelSelection: { instanceId, model: "gemini-2.5-pro" },
    runtimeMode,
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdBy: "user",
    creationSource: "web",
  });
  yield* orchestrator.dispatch({
    type: "message.dispatch",
    commandId: CommandId.make(`cmd-msg-${suffix}`),
    threadId,
    messageId,
    text: "Run command",
    attachments: [],
    dispatchMode: { type: "start_immediately" },
    createdBy: "user",
    creationSource: "web",
  });
  return { threadId, projectId };
});

it.live("runs fast foreground commands synchronously without holding background work", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const workspaceRoot = yield* fs.makeTempDirectoryScoped();
    yield* Effect.gen(function* () {
      const terminal = yield* TerminalCommandService.TerminalCommandService;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const { threadId } = yield* seedRunningThread("fg-fast", "full-access");
      const { runs } = yield* orchestrator.getThreadRecords(threadId, ["runs"]);
      const runId = runs.at(-1)!.id;
      const rejected = yield* terminal
        .run({
          threadId,
          command: "printf 'wrong run'",
          mode: "foreground",
          authorizedTurn: { runId: RunId.make("stale-run"), cwd: workspaceRoot },
        })
        .pipe(Effect.result);
      assert.strictEqual(rejected._tag, "Failure");

      const [result, failed] = yield* Effect.all(
        [
          terminal.run({
            threadId,
            command: "printf 'hello foreground'",
            description: "Check foreground output",
            mode: "foreground",
            authorizedTurn: { runId, cwd: workspaceRoot },
          }),
          terminal.run({
            threadId,
            command: "printf 'other result' >&2; exit 7",
            description: "Check failure output",
            mode: "foreground",
          }),
        ],
        { concurrency: 2 },
      );

      assert.equal(result.mode, "foreground");
      assert.equal(result.status, "completed");
      assert.equal(result.exitCode, 0);
      assert.equal(result.output, "hello foreground");
      assert.equal(failed.status, "failed");

      const projection = yield* orchestrator.getThreadRecords(threadId, [
        "providerThreads",
        "turnItems",
      ]);
      assert.isEmpty(projection.providerThreads[0]?.pendingBackgroundTasks ?? []);
      const commands = projection.turnItems.filter((item) => item.type === "command_execution");
      assert.lengthOf(commands, 2);
      const first = commands.find((item) => item.input === "printf 'hello foreground'");
      const second = commands.find((item) => item.input === "printf 'other result' >&2; exit 7");
      assert.deepEqual(
        [first?.commandSummary, first?.output, first?.exitCode, first?.status],
        ["Check foreground output", "hello foreground", 0, "completed"],
      );
      assert.deepEqual(
        [second?.commandSummary, second?.output, second?.exitCode, second?.status],
        ["Check failure output", "other result", 7, "failed"],
      );
    }).pipe(Effect.provide(makeTestLayer(workspaceRoot, 2_000)));
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.live(
  "escalates foreground commands past timeout to background, marks waiting, and wakes on exit",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspaceRoot = yield* fs.makeTempDirectoryScoped();
      yield* Effect.gen(function* () {
        const terminal = yield* TerminalCommandService.TerminalCommandService;
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const { threadId } = yield* seedRunningThread("fg-escalate");

        const result = yield* terminal.run({
          threadId,
          command: `${JSON.stringify(process.execPath)} -e "console.log('step1'); setTimeout(() => { console.log('step2'); }, 150)"`,
          mode: "foreground",
          description: "slow command",
        });

        assert.equal(result.mode, "foreground");
        assert.equal(result.status, "backgrounded");
        assert.isDefined(result.taskId);

        const during = yield* orchestrator.getThreadRecords(threadId, [
          "providerThreads",
          "turnItems",
        ]);
        const pending = during.providerThreads[0]?.pendingBackgroundTasks ?? [];
        assert.equal(pending.length, 1);
        assert.equal(pending[0]?.awaited, true);
        assert.equal(pending[0]?.kind, "command");
        const cmdItem = during.turnItems.find((item) => item.type === "command_execution");
        assert.equal(cmdItem?.status, "running");

        yield* awaitDomainEvent(
          orchestrator,
          (event): event is Extract<OrchestrationV2DomainEvent, { type: "turn-item.updated" }> =>
            event.type === "turn-item.updated" &&
            event.threadId === threadId &&
            event.payload.type === "command_execution" &&
            event.payload.status === "completed",
        );

        const after = yield* orchestrator.getThreadRecords(threadId, [
          "providerThreads",
          "turnItems",
          "messages",
        ]);
        assert.isEmpty(after.providerThreads[0]?.pendingBackgroundTasks ?? []);
        const wakeMessage = after.messages.find((m) => m.creationSource === "server");
        assert.isDefined(wakeMessage);
        assert.include(wakeMessage!.text, "exit code 0");
        assert.include(wakeMessage!.text, "step2");
        assert.equal(wakeMessage!.notification?.source.kind, "command");
      }).pipe(Effect.provide(makeTestLayer(workspaceRoot, 50)));
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.live("kills background_with_timeout commands on deadline and wakes thread", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const workspaceRoot = yield* fs.makeTempDirectoryScoped();
    yield* Effect.gen(function* () {
      const terminal = yield* TerminalCommandService.TerminalCommandService;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const { threadId } = yield* seedRunningThread("bg-timeout");

      const result = yield* terminal.run({
        threadId,
        command: `${JSON.stringify(process.execPath)} -e "setTimeout(() => {}, 30000)"`,
        mode: "background_with_timeout",
        timeoutSeconds: 1,
        description: "timed out job",
      });

      assert.equal(result.mode, "background_with_timeout");
      assert.equal(result.status, "running");

      yield* awaitDomainEvent(
        orchestrator,
        (event): event is Extract<OrchestrationV2DomainEvent, { type: "turn-item.updated" }> =>
          event.type === "turn-item.updated" &&
          event.threadId === threadId &&
          event.payload.type === "command_execution" &&
          event.payload.status === "failed",
      );

      const after = yield* orchestrator.getThreadRecords(threadId, [
        "providerThreads",
        "turnItems",
        "messages",
      ]);
      assert.isEmpty(after.providerThreads[0]?.pendingBackgroundTasks ?? []);
      const wakeMessage = after.messages.find((m) => m.creationSource === "server");
      assert.isDefined(wakeMessage);
      assert.include(wakeMessage!.text, "timed out after 1s");
    }).pipe(Effect.provide(makeTestLayer(workspaceRoot, 50)));
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.live("stops background commands on interruptThread without waking the thread", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const workspaceRoot = yield* fs.makeTempDirectoryScoped();
    yield* Effect.gen(function* () {
      const terminal = yield* TerminalCommandService.TerminalCommandService;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const { threadId } = yield* seedRunningThread("bg-stop");

      const result = yield* terminal.run({
        threadId,
        command: `${JSON.stringify(process.execPath)} -e "setTimeout(() => {}, 30000)"`,
        mode: "background",
      });
      assert.equal(result.status, "running");

      yield* terminal.interruptThread(threadId);

      yield* awaitDomainEvent(
        orchestrator,
        (event): event is Extract<OrchestrationV2DomainEvent, { type: "turn-item.updated" }> =>
          event.type === "turn-item.updated" &&
          event.threadId === threadId &&
          event.payload.type === "command_execution" &&
          event.payload.status === "interrupted",
      );

      const after = yield* orchestrator.getThreadRecords(threadId, ["providerThreads", "messages"]);
      assert.isEmpty(after.providerThreads[0]?.pendingBackgroundTasks ?? []);
      assert.isUndefined(after.messages.find((m) => m.creationSource === "server"));
    }).pipe(Effect.provide(makeTestLayer(workspaceRoot, 50)));
  }).pipe(Effect.provide(NodeServices.layer)),
);
