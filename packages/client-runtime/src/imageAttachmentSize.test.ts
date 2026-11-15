import { expect, it } from "@effect/vitest";
import { inlineImageSize } from "./imageAttachmentSize.ts";

it("fits source pixels to display density without enlarging or changing aspect ratio", () => {
  expect(inlineImageSize(256, 256, 2, 480, 480)).toEqual({ width: 128, height: 128 });
  expect(inlineImageSize(256, 256, 1, 480, 480)).toEqual({ width: 256, height: 256 });
  expect(inlineImageSize(800, 400, 2, 160, 480)).toEqual({ width: 160, height: 80 });
  expect(inlineImageSize(40, 20, 2, 480, 480)).toEqual({ width: 20, height: 10 });
  expect(inlineImageSize(0, 20, 2, 480, 480)).toBeNull();
});
