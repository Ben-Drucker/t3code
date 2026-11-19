import * as Effect from "effect/Effect";
import { OrchestratorMcpFailure } from "@t3tools/contracts";
import { McpProviderSessions } from "@t3tools/provider-core/server/McpProviderSessions";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as TerminalCommandService from "../../../terminal/TerminalCommandService.ts";
import { TerminalToolkit } from "./tools.ts";

const handlers = {
  t3_terminal_run: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.requireThreadMcpCapability("terminal");
      const service = yield* TerminalCommandService.TerminalCommandService;
      const sessions = yield* McpProviderSessions;
      const access = yield* sessions.read(scope.thread.threadId);
      const turn =
        access?.providerSessionId === scope.thread.providerSessionId
          ? access?.terminalAccess?.turn
          : undefined;
      if (scope.capabilities.has("terminal-unrestricted") && turn === undefined) {
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: "The T3 terminal requires an active Full access turn outside Plan mode.",
        });
      }
      return yield* service.run({
        threadId: scope.thread.threadId,
        command: input.command,
        mode: input.mode ?? "foreground",
        timeoutSeconds: input.timeoutSeconds,
        cwd: input.cwd,
        description: input.description ?? input.toolSummary,
        ...(turn === undefined ? {} : { authorizedTurn: turn }),
      });
    }),
  ),
} satisfies McpToolAccess.Handlers<typeof TerminalToolkit.tools>;

export const layer = McpToolAccess.toLayer(TerminalToolkit, handlers);
