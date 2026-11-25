import { describe, expect, it } from "vite-plus/test";

import { filterByPiEnabledModels } from "./piEnabledModels.ts";

const models = [
  "zai/glm-5.4",
  "kimi-coding/k3",
  "openrouter/z-ai/glm-5.3:free",
  "openrouter/qwen/qwen4-max",
].map((slug) => ({ slug }));

describe("filterByPiEnabledModels", () => {
  it("keeps exact ids, globs, and ids with a thinking suffix", () => {
    expect(
      filterByPiEnabledModels(models, ["zai/glm-5.4:high", "openrouter/z-ai/*", "KIMI-CODING/K3"]),
    ).toEqual([
      { slug: "zai/glm-5.4" },
      { slug: "kimi-coding/k3" },
      { slug: "openrouter/z-ai/glm-5.3:free" },
    ]);
  });

  it("keeps the active model and lists everything when nothing matches", () => {
    expect(filterByPiEnabledModels(models, ["zai/glm-5.4"], "kimi-coding/k3")).toEqual([
      { slug: "zai/glm-5.4" },
      { slug: "kimi-coding/k3" },
    ]);
    expect(filterByPiEnabledModels(models, ["nope/none"])).toBe(models);
    expect(filterByPiEnabledModels(models, [])).toBe(models);
  });
});
