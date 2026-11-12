import { expect, it } from "vite-plus/test";
import { localHtmlFileUrl } from "./localHtmlFile";

const local = {
  id: "local",
  label: "Local",
  runningDistro: null,
  httpBaseUrl: "http://127.0.0.1:3773/",
  wsBaseUrl: "ws://127.0.0.1:3773/",
};

it.each([
  ["reports/a #?%.html", "/repo", "file:///repo/reports/a%20%23%3F%25.html"],
  ["/tmp/café.html", "/repo", "file:///tmp/caf%C3%A9.html"],
  [String.raw`C:\reports\a b.HTM`, undefined, "file:///C:/reports/a%20b.HTM"],
  ["/tmp/a.pdf", "/repo", null],
  ["//server/share/a.html", undefined, null],
  ["index.html", undefined, null],
] as const)("resolves the local HTML path %s", (filePath, workspaceRoot, expected) => {
  expect(
    localHtmlFileUrl({
      filePath,
      workspaceRoot,
      httpBaseUrl: "http://127.0.0.1:3773",
      bootstraps: [local],
    }),
  ).toBe(expected);
});

it.each([
  { httpBaseUrl: "https://remote.example/", bootstraps: [local] },
  { httpBaseUrl: "https://tunnel.example/", bootstraps: [local] },
  { httpBaseUrl: local.httpBaseUrl, bootstraps: [{ ...local, runningDistro: "Ubuntu" }] },
  { httpBaseUrl: local.httpBaseUrl, bootstraps: [] },
])("keeps inaccessible files in the preview: $httpBaseUrl", (connection) => {
  expect(
    localHtmlFileUrl({ ...connection, filePath: "/repo/index.html", workspaceRoot: "/repo" }),
  ).toBeNull();
});
