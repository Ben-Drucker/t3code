export interface TranscriptTool {
  readonly name: string;
  readonly description: string | null;
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const parseRecord = (line: string): Record<string, unknown> | undefined => {
  try {
    return asRecord(JSON.parse(line));
  } catch {
    return undefined;
  }
};

const stringList = (value: unknown): ReadonlyArray<string> =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

/** Tool names a Claude session has loaded: `deferred_tools_delta` adds and removes, in order. */
export function claudeDeferredToolNames(lines: Iterable<string>): ReadonlyArray<string> {
  const names = new Set<string>();
  for (const line of lines) {
    const record = parseRecord(line);
    const attachment = asRecord(record?.attachment);
    if (record?.type !== "attachment" || attachment?.type !== "deferred_tools_delta") continue;
    for (const name of stringList(attachment.addedNames)) names.add(name);
    for (const name of stringList(attachment.removedNames)) names.delete(name);
  }
  return [...names].toSorted();
}

/** The names from `deferred_tools_delta`, marked deferred: the session has not loaded them yet. */
export function claudeDeferredEntries(
  lines: Iterable<string>,
): ReadonlyArray<{ readonly name: string; readonly description: null; readonly deferred: true }> {
  return claudeDeferredToolNames(lines).map((name) => ({
    name,
    description: null,
    deferred: true,
  }));
}

const descriptionOf = (value: Record<string, unknown>) =>
  typeof value.description === "string" && value.description !== "" ? value.description : null;

/**
 * Every `additional_tools` record in the rollout, flattened: namespaces become `<namespace>.<tool>`.
 * `mcp__*` namespaces are MCP servers, covered by the server sources, so they are skipped.
 */
export function codexAdditionalTools(lines: Iterable<string>): ReadonlyArray<TranscriptTool> {
  const tools = new Map<string, TranscriptTool>();
  for (const line of lines) {
    const record = parseRecord(line);
    const payload = asRecord(record?.payload);
    if (record?.type !== "response_item" || payload?.type !== "additional_tools") continue;
    for (const namespaceValue of Array.isArray(payload.tools) ? payload.tools : []) {
      const namespace = asRecord(namespaceValue);
      if (typeof namespace?.name !== "string" || namespace.name.startsWith("mcp__")) continue;
      if (!Array.isArray(namespace.tools)) {
        tools.set(namespace.name, { name: namespace.name, description: descriptionOf(namespace) });
        continue;
      }
      for (const toolValue of namespace.tools) {
        const tool = asRecord(toolValue);
        if (typeof tool?.name !== "string") continue;
        const name = `${namespace.name}.${tool.name}`;
        tools.set(name, { name, description: descriptionOf(tool) });
      }
    }
  }
  return [...tools.values()].toSorted((left, right) => left.name.localeCompare(right.name));
}

/** `mcp__<server>__<tool>` as Claude names MCP tools. Null for anything else. */
export function splitClaudeMcpToolName(
  name: string,
): { readonly server: string; readonly tool: string } | null {
  if (!name.startsWith("mcp__")) return null;
  const rest = name.slice("mcp__".length);
  const separator = rest.indexOf("__");
  if (separator <= 0 || separator + 2 >= rest.length) return null;
  return { server: rest.slice(0, separator), tool: rest.slice(separator + 2) };
}
