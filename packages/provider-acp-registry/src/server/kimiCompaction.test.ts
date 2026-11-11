import { expect, it } from "vite-plus/test";
import type { ModelSelection } from "@t3tools/contracts";
import { kimiLaunchEnvironment, parseKimiReservedTokens } from "./kimiCompaction.ts";

const select = (options: Record<string, string>) =>
  ({
    instanceId: "kimi",
    model: "kimi-code/k3",
    options: Object.entries(options).map(([id, value]) => ({ id, value })),
  }) as unknown as ModelSelection;

it.each([
  { name: "defaults", options: {}, expected: {} },
  { name: "buffer without a limit", options: { compactBuffer: "10" }, expected: {} },
  {
    name: "limit only",
    options: { contextLimit: "200000" },
    expected: { KIMI_MODEL_MAX_CONTEXT_SIZE: "200000" },
  },
  {
    name: "limit and buffer add back the reserve",
    options: { contextLimit: "200000", compactBuffer: "20" },
    expected: { KIMI_MODEL_MAX_CONTEXT_SIZE: "210000" },
  },
])("$name", ({ options, expected }) => {
  expect(kimiLaunchEnvironment(select(options), 50_000)).toEqual(expected);
});

it("reads the reserve only from the loop_control table", () => {
  expect(
    parseKimiReservedTokens(
      "[other]\nreserved_context_size = 1\n[loop_control]\nmax_retries_per_step = 3\nreserved_context_size = 50000\n",
    ),
  ).toBe(50_000);
  expect(parseKimiReservedTokens("[loop_control]\n")).toBeUndefined();
});
