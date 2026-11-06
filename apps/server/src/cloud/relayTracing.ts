import {
  nodeProcessRuntimeAttributes,
  processServiceInstanceId,
} from "@t3tools/shared/observability";
import * as RelayTracing from "@t3tools/shared/relayTracing";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import { resolveRelayClientTracingConfig } from "./publicConfig.ts";

const relayClientTracingConfig = resolveRelayClientTracingConfig();

/**
 * Relay traces leave the machine for T3 Connect. They stay off unless `T3CODE_TELEMETRY_ENABLED=true`
 * is set, and a policy with `telemetry: false` stops them regardless.
 */
export const relayLayer = (
  resource: Omit<RelayTracing.RelayClientTracingResource, "serviceInstanceId">,
  tracingConfig = relayClientTracingConfig,
) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const policy = yield* ManagedPolicy.ManagedPolicy;
      const optedIn = yield* Config.Boolean("T3CODE_TELEMETRY_ENABLED").pipe(
        Config.withDefault(false),
        Effect.orElseSucceed(() => false),
      );
      return RelayTracing.layer(
        optedIn && ManagedPolicy.deniedBy(policy, "telemetry") === undefined ? tracingConfig : null,
        {
          ...resource,
          serviceInstanceId: processServiceInstanceId(config.otelEnvironment.resourceAttributes),
        },
      );
    }),
  );

export const layerHeadlessRelayClient = relayLayer({
  serviceName: "t3code-server",
  runtime: "node",
  attributes: nodeProcessRuntimeAttributes(),
  client: "headless-cli",
});

export const layerServerRelayBroker = relayLayer({
  serviceName: "t3code-server",
  runtime: "node",
  attributes: nodeProcessRuntimeAttributes(),
  client: "environment-server",
  component: "relay-broker",
});
