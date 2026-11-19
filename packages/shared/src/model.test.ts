import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ProviderInstanceId, type ModelCapabilities } from "@t3tools/contracts";

import {
  applyClaudePromptEffortPrefix,
  buildExplicitProviderOptionSelectionsFromDescriptors,
  buildProviderOptionSelectionsFromDescriptors,
  createModelCapabilities,
  createModelSelection,
  describeRecentModelConfiguration,
  materializeModelConfiguration,
  readRecentModelConfigurations,
  rememberRecentModelConfiguration,
  getProviderOptionCurrentLabel,
  getProviderOptionDescriptors,
  readCustomModelEntries,
  modelSelectionsEqual,
  pickModelSelection,
  preservesLockedModelOptions,
  withImplicitFastModeDefault,
} from "./model.ts";

const codexCaps: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [
    {
      id: "reasoningEffort",
      label: "Reasoning",
      type: "select",
      options: [
        { id: "xhigh", label: "Extra High" },
        { id: "high", label: "High", isDefault: true },
      ],
      currentValue: "high",
    },
    {
      id: "fastMode",
      label: "Fast Mode",
      type: "boolean",
    },
  ],
});

describe("descriptor helpers", () => {
  it("keeps provider-fixed values when a saved thread or runtime reports another value", () => {
    const fixed = {
      id: "contextLimit",
      label: "Context limit",
      type: "select",
      disabledReason: "Fixed by Antigravity",
      currentValue: "256000",
      options: [{ id: "256000", label: "256K", isDefault: true }],
    } as const;
    const descriptors = getProviderOptionDescriptors({
      caps: { optionDescriptors: [fixed] },
      selections: [{ id: "contextLimit", value: "1048576" }],
    });
    expect(descriptors).toEqual([fixed]);
    expect(
      getProviderOptionCurrentLabel(
        descriptors[0],
        { instanceId: ProviderInstanceId.make("antigravity"), model: "gemini" },
        {
          instanceId: ProviderInstanceId.make("antigravity"),
          model: "gemini",
          options: [{ id: "contextLimit", value: "1048576" }],
        },
      ),
    ).toBe("256K");
  });
  it("builds dispatch options only from explicit selections", () => {
    const descriptors = getProviderOptionDescriptors({
      caps: codexCaps,
      selections: [{ id: "fastMode", value: true }],
    });

    expect(buildExplicitProviderOptionSelectionsFromDescriptors(descriptors, undefined)).toBe(
      undefined,
    );
    expect(
      buildExplicitProviderOptionSelectionsFromDescriptors(descriptors, [
        { id: "fastMode", value: true },
      ]),
    ).toEqual([{ id: "fastMode", value: true }]);
  });

  it("dispatches an old Ultracode effort as Extra High with the Ultracode toggle", () => {
    const legacy = [{ id: "effort", value: "ultracode" }];
    const descriptors = getProviderOptionDescriptors({
      caps: createModelCapabilities({
        optionDescriptors: [
          {
            id: "effort",
            label: "Reasoning",
            type: "select",
            options: [
              { id: "high", label: "High", isDefault: true },
              { id: "xhigh", label: "Extra High" },
            ],
          },
          { id: "ultracode", label: "Ultracode", type: "boolean" },
        ],
      }),
      selections: legacy,
    });

    expect(buildExplicitProviderOptionSelectionsFromDescriptors(descriptors, legacy)).toEqual([
      { id: "effort", value: "xhigh" },
      { id: "ultracode", value: true },
    ]);
  });

  it("compares complete model selections independent of option ordering", () => {
    const left = createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.4", [
      { id: "reasoningEffort", value: "high" },
      { id: "fastMode", value: true },
    ]);
    const reordered = createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.4", [
      { id: "fastMode", value: true },
      { id: "reasoningEffort", value: "high" },
    ]);

    expect(modelSelectionsEqual(left, reordered)).toBe(true);
    expect(
      modelSelectionsEqual(left, {
        ...reordered,
        options: [
          { id: "fastMode", value: true },
          { id: "reasoningEffort", value: "medium" },
        ],
      }),
    ).toBe(false);
    expect(modelSelectionsEqual(left, { ...reordered, model: "gpt-5.5" })).toBe(false);
  });

  it("keeps the options when the current model is picked again", () => {
    const codex = ProviderInstanceId.make("codex");
    const current = createModelSelection(codex, "gpt-5.4", [
      { id: "reasoningEffort", value: "high" },
    ]);

    expect(pickModelSelection(current, codex, "gpt-5.4")).toBe(current);
    expect(pickModelSelection(current, codex, "gpt-5.5")).toEqual({
      instanceId: "codex",
      model: "gpt-5.5",
    });
    expect(pickModelSelection(current, ProviderInstanceId.make("codex_work"), "gpt-5.4")).toEqual({
      instanceId: "codex_work",
      model: "gpt-5.4",
    });
    expect(pickModelSelection(null, codex, "gpt-5.4")).toEqual({
      instanceId: "codex",
      model: "gpt-5.4",
    });
  });
});

describe("applyClaudePromptEffortPrefix", () => {
  it("keeps slash commands intact when ultrathink is selected", () => {
    expect(applyClaudePromptEffortPrefix("/compact", "ultrathink")).toBe("/compact");
    expect(applyClaudePromptEffortPrefix(" /compact keep recent errors ", "ultrathink")).toBe(
      "/compact keep recent errors",
    );
    expect(applyClaudePromptEffortPrefix(" /review src/model.ts ", "ultrathink")).toBe(
      "/review src/model.ts",
    );
    expect(applyClaudePromptEffortPrefix("/security-review", "ultrathink")).toBe(
      "/security-review",
    );
    expect(applyClaudePromptEffortPrefix("/plugin:skill run", "ultrathink")).toBe(
      "/plugin:skill run",
    );
    expect(applyClaudePromptEffortPrefix("/deploy.prod to staging", "ultrathink")).toBe(
      "/deploy.prod to staging",
    );
  });

  it("still adds the ultrathink prefix to ordinary prompts", () => {
    expect(applyClaudePromptEffortPrefix("Investigate this failure", "ultrathink")).toBe(
      "Ultrathink:\nInvestigate this failure",
    );
    expect(applyClaudePromptEffortPrefix("/home/theo/app.ts crashed on load", "ultrathink")).toBe(
      "Ultrathink:\n/home/theo/app.ts crashed on load",
    );
  });
});

describe("readCustomModelEntries", () => {
  const capabilities: ModelCapabilities = {
    optionDescriptors: [
      {
        id: "effort",
        label: "Reasoning",
        type: "select",
        options: [{ id: "high", label: "High", isDefault: true }],
        currentValue: "high",
      },
    ],
  };

  it("resolves bare slugs and entries, trimming and deduplicating on slug", () => {
    expect(
      readCustomModelEntries([
        " bare ",
        { slug: "named", name: " Named ", capabilities },
        "bare",
        { slug: "named", name: "Second" },
        "",
        { name: "no slug" },
        42,
      ]),
    ).toEqual([
      { slug: "bare", name: "bare", capabilities: null },
      { slug: "named", name: "Named", capabilities },
    ]);
  });

  it("drops unparseable capabilities but keeps the entry", () => {
    expect(
      readCustomModelEntries([{ slug: "x", capabilities: { optionDescriptors: "nope" } }]),
    ).toEqual([{ slug: "x", name: "x", capabilities: null }]);
    expect(readCustomModelEntries("not a list")).toEqual([]);
  });
});

describe("provider-reported option display", () => {
  const selection = createModelSelection(ProviderInstanceId.make("opencode"), "ling");
  const reported = { ...selection, options: [{ id: "variant", value: "default" }] };
  const descriptor = {
    id: "variant",
    label: "Reasoning",
    type: "select" as const,
    options: [
      { id: "none", label: "None" },
      { id: "thinking", label: "Thinking" },
    ],
  };

  it("shows explicit reports without adding a choice or a dispatch option", () => {
    expect(getProviderOptionCurrentLabel(descriptor, selection, reported)).toBe("Default");
    expect(
      getProviderOptionCurrentLabel(descriptor, selection, {
        ...reported,
        options: [{ id: "variant", value: "thinking" }],
      }),
    ).toBe("Thinking");
    expect(
      getProviderOptionCurrentLabel(
        { ...descriptor, currentValue: "none" },
        { ...selection, options: [{ id: "variant", value: "none" }] },
        reported,
      ),
    ).toBe("None");
    expect(descriptor.options.map((option) => option.id)).toEqual(["none", "thinking"]);
    expect(buildProviderOptionSelectionsFromDescriptors([descriptor])).toBeUndefined();
    expect(getProviderOptionCurrentLabel(descriptor, selection)).toBe("Unknown");
    const effortDescriptor = { ...descriptor, id: "effort", currentValue: "default" };
    expect(getProviderOptionCurrentLabel(effortDescriptor, selection)).toBeUndefined();
    expect(
      getProviderOptionCurrentLabel(effortDescriptor, selection, {
        ...reported,
        model: "other",
        options: [{ id: "effort", value: "default" }],
      }),
    ).toBeUndefined();
    expect(
      getProviderOptionCurrentLabel(effortDescriptor, selection, {
        ...reported,
        options: [{ id: "effort", value: "default" }],
      }),
    ).toBe("Default");
    expect(
      getProviderOptionCurrentLabel({ ...descriptor, currentValue: "thinking" }, selection),
    ).toBe("Unknown");
  });

  it.each([
    { ...selection, model: "other" },
    { ...selection, instanceId: ProviderInstanceId.make("other") },
    { ...selection, options: [{ id: "variant", value: "none" }] },
  ])("ignores reports after changing the model, instance, or option: %j", (selected) => {
    expect(getProviderOptionCurrentLabel(descriptor, selected, reported)).toBe("Unknown");
  });
});

describe("withImplicitFastModeDefault", () => {
  // regression: #2981 a remembered Fast mode choice must survive the implicit default on new chats
  it("injects fastMode false only when the model exposes fastMode and no selection exists", () => {
    const caps = createModelCapabilities({
      optionDescriptors: [{ id: "fastMode", label: "Fast", type: "boolean", currentValue: true }],
    });

    expect(withImplicitFastModeDefault(caps, undefined)).toEqual([
      { id: "fastMode", value: false },
    ]);
    expect(withImplicitFastModeDefault(caps, [{ id: "fastMode", value: true }])).toEqual([
      { id: "fastMode", value: true },
    ]);
  });
});

it("keeps ten distinct, valid recent configurations with exact settings and environment identity", () => {
  const instance = ProviderInstanceId.make("codex");
  const local = EnvironmentId.make("local");
  const remote = EnvironmentId.make("remote");
  const high = materializeModelConfiguration(createModelSelection(instance, "gpt"), codexCaps);
  const fast = createModelSelection(instance, "gpt", [
    { id: "fastMode", value: true },
    { id: "reasoningEffort", value: "xhigh" },
  ]);
  const history = Array.from({ length: 10 }, (_, index) => ({
    environmentId: local,
    selection: createModelSelection(instance, `older-${index}`),
  }));
  const recent = rememberRecentModelConfiguration(history, {
    environmentId: local,
    selection: high,
  });
  const paired = rememberRecentModelConfiguration(recent, {
    environmentId: remote,
    selection: high,
  });
  const distinct = rememberRecentModelConfiguration(paired, {
    environmentId: local,
    selection: fast,
  });
  const reversed = createModelSelection(instance, "gpt", [...fast.options!].reverse());
  const updated = rememberRecentModelConfiguration(distinct, {
    environmentId: local,
    selection: reversed,
  });
  expect(updated).toHaveLength(10);
  expect(updated.slice(0, 3)).toEqual([
    { environmentId: local, selection: reversed },
    { environmentId: remote, selection: high },
    { environmentId: local, selection: high },
  ]);
  expect(readRecentModelConfigurations(JSON.parse(JSON.stringify(updated)))).toEqual(updated);
  expect(describeRecentModelConfiguration(fast, codexCaps, (on) => (on ? "On" : "Off"))).toBe(
    "Fast Mode: On · Reasoning: Extra High",
  );
  expect(describeRecentModelConfiguration(fast, undefined, String)).toBeNull();
});

it("blocks restoring launch-only options after the same provider has started", () => {
  const instance = ProviderInstanceId.make("codex");
  const caps = createModelCapabilities({
    optionDescriptors: (codexCaps.optionDescriptors ?? []).map((descriptor) =>
      descriptor.id === "reasoningEffort" ? { ...descriptor, lockedOnceStarted: true } : descriptor,
    ),
  });
  const current = createModelSelection(instance, "gpt");
  expect(
    preservesLockedModelOptions(
      createModelSelection(instance, "gpt", [{ id: "reasoningEffort", value: "xhigh" }]),
      caps,
      current,
      caps,
    ),
  ).toBe(false);
  expect(
    preservesLockedModelOptions(
      createModelSelection(instance, "gpt", [{ id: "fastMode", value: true }]),
      caps,
      current,
      caps,
    ),
  ).toBe(true);
});
