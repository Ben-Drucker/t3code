import { describe, expect, it } from "vite-plus/test";

import { antigravityBreakdownFromGeneration } from "./AntigravityContextBreakdown.ts";

const varint = (value: number) => {
  const out: number[] = [];
  let rest = value;
  while (rest > 0x7f) {
    out.push((rest & 0x7f) | 0x80);
    rest = Math.floor(rest / 128);
  }
  out.push(rest);
  return out;
};
const int = (field: number, value: number) => [...varint(field << 3), ...varint(value)];
const bytes = (field: number, payload: ReadonlyArray<number>) => [
  ...varint((field << 3) | 2),
  ...varint(payload.length),
  ...payload,
];
const text = (field: number, value: string) => bytes(field, [...new TextEncoder().encode(value)]);
const group = (type: number, tokens: number, children: ReadonlyArray<number> = []) =>
  bytes(1, [...int(2, type), ...int(4, tokens), ...children]);

describe("antigravityBreakdownFromGeneration", () => {
  it("folds the call's token groups into messages, skills, and system", () => {
    const groups = [
      ...group(1, 4_000, bytes(5, [...text(1, "skills"), ...int(3, 1_000)])),
      ...group(2, 5_000),
      ...group(
        7,
        13_000,
        bytes(5, [...text(1, "0: USER_INPUT"), ...int(3, 400)]).concat(
          bytes(5, [...text(1, "1: RUN_COMMAND"), ...int(3, 12_600)]),
        ),
      ),
    ];
    const generation = bytes(1, bytes(9, bytes(10, bytes(3, groups))));
    expect(antigravityBreakdownFromGeneration(Uint8Array.from(generation))).toEqual({
      usedTokens: 22_000,
      breakdown: [
        { category: "messages", tokens: 13_000 },
        { category: "skills", tokens: 1_000 },
        { category: "system", tokens: 8_000 },
      ],
    });
  });
});
