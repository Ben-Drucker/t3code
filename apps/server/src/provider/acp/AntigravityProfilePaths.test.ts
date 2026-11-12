// @effect-diagnostics nodeBuiltinImport:off -- pure path fixtures run without an Effect runtime.
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { resolveAntigravityConversationStore } from "./AntigravityProfilePaths.ts";

describe("Antigravity conversation store", () => {
  it("selects the managed profile or standalone CLI overrides from the launch environment", () => {
    const userHome = NodePath.resolve("test-home");
    const profileDirectory = NodePath.resolve("test-profile");
    const cwd = NodePath.resolve("test-workspace");
    const override = NodePath.join(userHome, "other-gemini");
    for (const [managed, environment, expected] of [
      [
        true,
        { ANTIGRAVITY_GEMINI_DIR: override, ANTIGRAVITY_APP_DATA_DIR: "other-cli" },
        { profileDirectory, appDataDirectory: "antigravity-acp" },
      ],
      [
        false,
        { GEMINI_HOME: profileDirectory },
        {
          profileDirectory: NodePath.join(userHome, ".gemini"),
          appDataDirectory: "antigravity-cli",
        },
      ],
      [
        false,
        { ANTIGRAVITY_GEMINI_DIR: override, ANTIGRAVITY_APP_DATA_DIR: "other-cli" },
        { profileDirectory: override, appDataDirectory: "other-cli" },
      ],
    ] as const) {
      expect(
        resolveAntigravityConversationStore({
          managed,
          environment,
          userHome,
          profileDirectory,
          cwd,
        }),
      ).toEqual(expected);
    }
  });
});
