import * as Effect from "effect/Effect";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as TerminalCommandService from "../../../terminal/TerminalCommandService.ts";
import { TerminalToolkit } from "./tools.ts";

const handlers = {
  t3_terminal_run: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.requireThreadMcpCapability("terminal");
      const service = yield* TerminalCommandService.TerminalCommandService;
      return yield* service.run({
        threadId: scope.thread.threadId,
        command: input.command,
        mode: input.mode ?? "foreground",
        timeoutSeconds: input.timeoutSeconds,
        cwd: input.cwd,
        description: input.description,
      });
    }),
  ),
} satisfies McpToolAccess.Handlers<typeof TerminalToolkit.tools>;

export const layer = McpToolAccess.toLayer(TerminalToolkit, handlers);
