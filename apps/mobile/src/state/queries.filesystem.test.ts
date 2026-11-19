import { AuthFilesystemReadScope, EnvironmentId, type AuthSessionState } from "@t3tools/contracts";
import { beforeEach, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  session: null as Pick<AuthSessionState, "authenticated" | "scopes"> | null,
  sessionError: null as string | null,
  phase: "connected" as "connected" | "offline",
  sessionAtom: {},
  searchAtom: {},
  browseAtom: {},
  searchRequests: vi.fn(),
  browseRequests: vi.fn(),
}));

vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useCallback: <A>(callback: A) => callback,
  useEffect: () => {},
  useMemo: <A>(factory: () => A) => factory(),
  useState: <A>(value: A) => [value, vi.fn()],
}));
vi.mock("gt-react-native", async (importOriginal) => {
  const gt = await importOriginal<typeof import("gt-react-native")>();
  return { ...gt, useGT: () => gt.mFallback, useMessages: () => gt.mFallback };
});
vi.mock("./session", () => ({
  environmentSession: { sessionStateAtom: () => state.sessionAtom },
}));
vi.mock("./presentation", () => ({
  useEnvironmentPresentation: () => ({
    isReady: true,
    presentation: { connection: { phase: state.phase, error: null } },
  }),
}));
vi.mock("./pull-requests", () => ({ composerPullRequests: {} }));
vi.mock("./filesystem", () => ({
  filesystemEnvironment: {
    browse: (target: unknown) => {
      state.browseRequests(target);
      return state.browseAtom;
    },
  },
}));
vi.mock("./projects", () => ({
  projectEnvironment: {
    searchEntries: (target: unknown) => {
      state.searchRequests(target);
      return state.searchAtom;
    },
  },
}));
vi.mock("./atom-registry", () => ({ appAtomRegistry: {} }));
vi.mock("./orchestration", () => ({ orchestrationEnvironment: {} }));
vi.mock("./threads", () => ({ useEnvironmentThread: vi.fn() }));
vi.mock("./vcs", () => ({ vcsEnvironment: {} }));
vi.mock("./query", () => ({
  useEnvironmentQuery: (atom: unknown) => ({
    data:
      atom === state.sessionAtom
        ? state.session
        : atom === state.searchAtom
          ? { entries: [{ path: "src/index.ts", kind: "file" }] }
          : atom === state.browseAtom
            ? { entries: [{ fullPath: "/other/project.txt", kind: "file" }] }
            : null,
    error: atom === state.sessionAtom ? state.sessionError : null,
    isPending: atom === state.sessionAtom && state.session === null && state.sessionError === null,
    refresh: vi.fn(),
  }),
}));

import { useComposerPathSearch } from "./queries";

const target = {
  environmentId: EnvironmentId.make("test-environment"),
  cwd: "/repo",
  query: "src",
};

beforeEach(() => {
  state.session = null;
  state.sessionError = null;
  state.phase = "connected";
  state.searchRequests.mockClear();
  state.browseRequests.mockClear();
});

it("keeps a file search pending until its grant loads, then shows matches", () => {
  expect(useComposerPathSearch(target)).toMatchObject({
    entries: [],
    error: null,
    isPending: true,
  });
  state.session = { authenticated: true, scopes: [AuthFilesystemReadScope] };
  expect(useComposerPathSearch(target)).toMatchObject({
    entries: [{ path: "src/index.ts", kind: "file" }],
    error: null,
    isPending: false,
  });
});

it("searches workspace entries for a bare @", () => {
  state.session = { authenticated: true, scopes: [AuthFilesystemReadScope] };
  useComposerPathSearch({ ...target, query: "" });
  expect(state.searchRequests).toHaveBeenCalledExactlyOnceWith({
    environmentId: target.environmentId,
    input: { cwd: target.cwd, query: "", limit: 20 },
  });
});

it("browses an explicit host path only after the filesystem grant loads", () => {
  const pathTarget = { ...target, query: "/other/pro" };
  expect(useComposerPathSearch(pathTarget).isPending).toBe(true);
  expect(state.browseRequests).not.toHaveBeenCalled();

  state.session = { authenticated: true, scopes: [AuthFilesystemReadScope] };
  expect(useComposerPathSearch(pathTarget).entries).toEqual([
    { path: "/other/project.txt", kind: "file" },
  ]);
  expect(state.browseRequests).toHaveBeenCalledExactlyOnceWith({
    environmentId: target.environmentId,
    input: { partialPath: "/other/pro", includeFiles: true, cwd: target.cwd },
  });
  expect(state.searchRequests).not.toHaveBeenCalled();
});
