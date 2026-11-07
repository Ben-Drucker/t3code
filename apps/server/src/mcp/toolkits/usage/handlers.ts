import {
  OrchestratorMcpFailure,
  type ServerProvider,
  type ServerProviderUsageLimits,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as ProviderRegistry from "../../../provider/ProviderRegistry.ts";
import * as UsageLimitSources from "../../../usage/UsageLimitSources.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { UsageToolkit } from "./tools.ts";

export function withRemaining(limits: ServerProviderUsageLimits) {
  return {
    ...limits,
    windows: limits.windows.map((window) => ({
      ...window,
      remainingPercent: Math.max(0, Math.round((100 - window.usedPercent) * 100) / 100),
    })),
  };
}

export function summarize(provider: ServerProvider) {
  return {
    instanceId: provider.instanceId,
    driver: provider.driver,
    ...(provider.displayName === undefined ? {} : { displayName: provider.displayName }),
    enabled: provider.enabled,
    installed: provider.installed,
    status: provider.status,
    hasUsageLimits: (provider.usageLimits?.windows.length ?? 0) > 0,
  };
}

/** Matches an instance id, a driver, or a display name, ignoring case. */
export function matchesProvider(provider: ServerProvider, query: string): boolean {
  const wanted = query.trim().toLowerCase();
  return [provider.instanceId, provider.driver, provider.displayName].some(
    (name) => name !== undefined && String(name).toLowerCase() === wanted,
  );
}

export const layer = McpToolAccess.toLayer(UsageToolkit, {
  t3_usage_providers: McpToolAccess.reads(() =>
    Effect.gen(function* () {
      const providers = yield* (yield* ProviderRegistry.ProviderRegistry).getProviders;
      return { providers: providers.map(summarize) };
    }),
  ),
  t3_usage_read: McpToolAccess.reads(({ provider: query }) =>
    Effect.gen(function* () {
      const providers = yield* (yield* ProviderRegistry.ProviderRegistry).getProviders;
      const matched = providers.filter((provider) => matchesProvider(provider, query));
      if (matched.length === 0) {
        return yield* new OrchestratorMcpFailure({
          code: "provider_unavailable",
          message: `No provider matches "${query}". Known: ${providers
            .map((provider) => provider.instanceId)
            .join(", ")}.`,
        });
      }
      const drivers = new Set(matched.map((provider) => provider.driver));
      const sources = yield* (yield* UsageLimitSources.UsageLimitSources).current;
      return {
        provider: query,
        matches: matched.map((provider) => ({
          ...summarize(provider),
          version: provider.version,
          auth: provider.auth,
          ...(provider.message === undefined ? {} : { message: provider.message }),
          ...(provider.availability === undefined ? {} : { availability: provider.availability }),
          ...(provider.unavailableReason === undefined
            ? {}
            : { unavailableReason: provider.unavailableReason }),
          checkedAt: provider.checkedAt,
          modelCount: provider.models.length,
          ...(provider.usageLimits === undefined
            ? {}
            : { usageLimits: withRemaining(provider.usageLimits) }),
        })),
        externalSources: sources
          .map((source) => ({
            sourceId: source.id,
            label: source.label,
            checkedAt: source.checkedAt,
            ...(source.error === undefined ? {} : { error: source.error }),
            accounts: source.accounts
              .filter((account) => drivers.has(account.driver))
              .map((account) => ({ ...account, usageLimits: withRemaining(account.usageLimits) })),
          }))
          .filter((source) => source.accounts.length > 0 || source.error !== undefined),
      };
    }),
  ),
});
