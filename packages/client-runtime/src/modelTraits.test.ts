import type { ProviderOptionDescriptor } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildTraitsTriggerDisplay,
  getDescriptorStringValue,
  getPromptControlledTraits,
  getTraitSelectChange,
  replaceDescriptorCurrentValue,
} from "./modelTraits.ts";

describe("buildTraitsTriggerDisplay", () => {
  it("does not change a provider-fixed select or boolean through trait shortcuts", () => {
    const descriptor = {
      id: "contextLimit",
      label: "Context limit",
      type: "select",
      currentValue: "256000",
      disabledReason: "Fixed by Antigravity",
      options: [{ id: "256000", label: "256K" }],
    } as const;
    const descriptors = [
      descriptor,
      {
        id: "fixedFlag",
        label: "Fixed",
        type: "boolean",
        currentValue: true,
        disabledReason: "Fixed",
      },
    ] as const;
    expect(
      getTraitSelectChange(
        { ...getPromptControlledTraits(descriptors, ""), descriptors },
        descriptor,
        "",
        "1048576",
      ),
    ).toBeNull();
    expect(replaceDescriptorCurrentValue(descriptors, "fixedFlag", false)).toEqual(descriptors);
  });
  it.each([
    { currentValue: undefined, defaultValue: undefined, value: null, label: "Thinking" },
    { currentValue: undefined, defaultValue: "high", value: "high", label: "High" },
    { currentValue: "low", defaultValue: undefined, value: "low", label: "Low" },
    { currentValue: "max", defaultValue: "high", value: "max", label: "Max" },
    { id: "effort", currentValue: undefined, defaultValue: undefined, value: null, label: "" },
  ])("labels Pi thinking without inventing a selection: $label ($value)", (input) => {
    const descriptor: Extract<ProviderOptionDescriptor, { type: "select" }> = {
      id: input.id ?? "thinking",
      label: "Thinking",
      type: "select",
      options: ["low", "high", "max"].map((id) => ({
        id,
        label: id[0]!.toUpperCase() + id.slice(1),
        ...(id === input.defaultValue ? { isDefault: true } : {}),
      })),
      ...(input.currentValue ? { currentValue: input.currentValue } : {}),
    };

    expect(
      buildTraitsTriggerDisplay({
        descriptors: [descriptor],
        primarySelectDescriptorId: descriptor.id,
        ultrathinkPromptControlled: false,
      }).label,
    ).toBe(input.label);
    expect(getDescriptorStringValue(descriptor)).toBe(input.value);
  });
});
