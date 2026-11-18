export { isFilesystemPathQuery } from "@t3tools/shared/composerTrigger";

/** The part of a typed path that is already settled: everything up to the last separator. */
export function filesystemPathDirectoryPrefix(query: string): string {
  if (query === "~") return "~/";
  const separatorIndex = Math.max(query.lastIndexOf("/"), query.lastIndexOf("\\"));
  return separatorIndex >= 0 ? query.slice(0, separatorIndex + 1) : "";
}
