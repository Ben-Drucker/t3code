import { WS_METHODS } from "@t3tools/contracts";
import type { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

export function createComposerToolsEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    /** Opened with the `%` menu; each snapshot replaces the last as MCP servers report in. */
    list: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:composer-tools:list",
      tag: WS_METHODS.composerToolsList,
    }),
    /** A Pi thread's tools as its session last reported them, and the saved choices. */
    piTools: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:composer-tools:pi-tools",
      tag: WS_METHODS.piToolsGet,
    }),
    setPiToolChoices: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:composer-tools:set-pi-tool-choices",
      tag: WS_METHODS.piToolsSetChoices,
    }),
  };
}
