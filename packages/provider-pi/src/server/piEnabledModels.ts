import * as NodeOS from "node:os";

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

const THINKING_SUFFIX = /:(off|minimal|low|medium|high|xhigh|max)$/i;

const PiSettingsFile = Schema.fromJsonString(
  Schema.Struct({ enabledModels: Schema.optional(Schema.Array(Schema.Unknown)) }),
);

/** Pi's global `enabledModels`, or none when unset or unreadable. */
export const readPiEnabledModels = Effect.fn("PiProviderStatus.readPiEnabledModels")(function* (
  environment: NodeJS.ProcessEnv,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory =
    environment.PI_CODING_AGENT_DIR?.trim() || path.join(NodeOS.homedir(), ".pi", "agent");
  const settings = yield* fileSystem.readFileString(path.join(directory, "settings.json")).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(PiSettingsFile)),
    Effect.orElseSucceed(() => ({ enabledModels: undefined })),
  );
  return (settings.enabledModels ?? []).filter(
    (pattern): pattern is string => typeof pattern === "string",
  );
});

function matcher(pattern: string): (slug: string) => boolean {
  const trimmed = pattern.trim().replace(THINKING_SUFFIX, "").toLowerCase();
  if (!/[*?]/.test(trimmed)) return (slug) => slug.toLowerCase() === trimmed;
  const source = trimmed
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replaceAll("*", ".*")
    .replaceAll("?", ".");
  const regex = new RegExp(`^${source}$`);
  return (slug) => regex.test(slug.toLowerCase());
}

/**
 * Pi lists every model its credentials reach and applies `enabledModels` only to cycling, so T3
 * applies it to the model picker too. Exact `provider/id` patterns and globs match; when no
 * pattern matches anything, nothing is filtered.
 */
export function filterByPiEnabledModels<Model extends { readonly slug: string }>(
  models: ReadonlyArray<Model>,
  patterns: ReadonlyArray<string>,
  keepSlug?: string,
): ReadonlyArray<Model> {
  if (patterns.length === 0) return models;
  const matchers = patterns.map(matcher);
  const enabled = models.filter(
    (model) => model.slug === keepSlug || matchers.some((matches) => matches(model.slug)),
  );
  return enabled.length === 0 ? models : enabled;
}
