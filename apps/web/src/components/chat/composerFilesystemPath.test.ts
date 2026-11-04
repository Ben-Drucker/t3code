import { describe, expect, it } from "vite-plus/test";

import { filesystemPathDirectoryPrefix, isFilesystemPathQuery } from "./composerFilesystemPath";

describe("isFilesystemPathQuery", () => {
  it("recognizes absolute, home, and explicit relative paths", () => {
    for (const query of ["/", "/Users/me", "~", "~/code", "./src", "../x", "..", "C:\\temp"]) {
      expect(isFilesystemPathQuery(query)).toBe(true);
    }
  });

  it("leaves plain project searches alone", () => {
    for (const query of ["", "src/index.ts", "readme", ".gitignore", "~foo"]) {
      expect(isFilesystemPathQuery(query)).toBe(false);
    }
  });
});

describe("filesystemPathDirectoryPrefix", () => {
  it("keeps everything up to the last separator", () => {
    expect(filesystemPathDirectoryPrefix("/Users/me/Co")).toBe("/Users/me/");
    expect(filesystemPathDirectoryPrefix("~/")).toBe("~/");
    expect(filesystemPathDirectoryPrefix("~")).toBe("~/");
    expect(filesystemPathDirectoryPrefix("/")).toBe("/");
  });
});
