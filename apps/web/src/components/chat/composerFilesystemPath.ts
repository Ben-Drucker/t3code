/** An `@` query that names a place on disk rather than a fuzzy project search. */
export function isFilesystemPathQuery(query: string): boolean {
  return /^(?:~(?:[\\/]|$)|\/|\.{1,2}(?:[\\/]|$)|[A-Za-z]:[\\/])/u.test(query);
}

/** The part of a typed path that is already settled: everything up to the last separator. */
export function filesystemPathDirectoryPrefix(query: string): string {
  if (query === "~") return "~/";
  const separatorIndex = Math.max(query.lastIndexOf("/"), query.lastIndexOf("\\"));
  return separatorIndex >= 0 ? query.slice(0, separatorIndex + 1) : "";
}
