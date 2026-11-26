/**
 * Where a Pi tool sits in T3's tool picker, ending with its label. MCP tools go under their
 * server, T3's under `T3`, and Pi's own under `Pi`. `t3_X_Y` is T3 > X > Y; with more parts,
 * the last is the leaf and the middle ones stay joined: `t3_X_Y_Z_W` is T3 > X_Y_Z > W.
 */
export function piToolPath(name: string): ReadonlyArray<string> {
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
  const server = mcp?.[1];
  const tool = mcp?.[2] ?? name;
  const source = server === undefined ? "Pi" : server === "t3-code" ? "T3" : server;
  const body = source === "T3" && tool.startsWith("t3_") ? tool.split("_").slice(1) : [];
  if (body.length < 2) return [source, tool];
  return [source, body.slice(0, -1).join("_"), body.at(-1)!];
}
