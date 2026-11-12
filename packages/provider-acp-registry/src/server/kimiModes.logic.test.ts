import { expect, it } from "vite-plus/test";
import { createModelCapabilities } from "@t3tools/shared/model";
import { withKimiRuntimeControls } from "./kimiModes.ts";

it("removes both native permission controls while retaining reasoning options", () => {
  const option = (id: string) => ({
    id,
    label: id,
    type: "select" as const,
    options: [{ id: "default", label: "Default" }],
  });
  const capabilities = createModelCapabilities({
    optionDescriptors: [option("mode"), option("_t3/session-mode"), option("thinking")],
  });
  expect(
    withKimiRuntimeControls(capabilities).optionDescriptors?.map((option) => option.id),
  ).toEqual(["thinking"]);
});
