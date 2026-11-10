import { expect, it } from "vite-plus/test";
import {
  bannerScreenPoint,
  notificationArguments,
  selectAutofillEntry,
} from "./FirefoxAutofillGeometry.ts";

it("measures the iframe independently of its zero-width shadow host and converts scaled coordinates", () => {
  const input = {
    screen: { x: -1400, y: 80 },
    viewport: { width: 1200, height: 800 },
    frame: { x: 300, y: 12, width: 500, height: 200 },
    banner: { width: 400, height: 160 },
    label: { x: 100, y: 80, width: 80, height: 24 },
  };
  expect(bannerScreenPoint(input)).toEqual({ x: -925, y: 207 });
  for (const frame of [
    { ...input.frame, width: 0 },
    { ...input.frame, x: 1300 },
    { ...input.frame, y: NaN },
  ])
    expect(() => bannerScreenPoint({ ...input, frame })).toThrow();
  expect(() => bannerScreenPoint({ ...input, label: { ...input.label, x: 399 } })).toThrow();
});

it("chooses only exact entry labels and refuses ambiguous matches", () => {
  const entries = [
    { title: "Acme", username: "ben@example.test", index: 0 },
    { title: "Work", username: "ben@example.test", index: 1 },
    { title: "Acme", username: "ben+other@example.test", index: 2 },
  ];
  expect(selectAutofillEntry(entries, { title: "Work", username: "ben@example.test" })).toEqual(
    entries[1],
  );
  expect(selectAutofillEntry(entries, { username: "BEN@example.test" })).toBeUndefined();
  expect(selectAutofillEntry(entries, { username: "ben" })).toBeUndefined();
  expect(() => selectAutofillEntry(entries, {})).toThrow("More than one");
  expect(() => selectAutofillEntry(entries, { username: "ben@example.test" })).toThrow(
    "More than one",
  );
  expect(selectAutofillEntry([entries[0]!], {})).toEqual(entries[0]);
});

it("keeps notification arguments separate and validates identifiers for post and confirmed removal", () => {
  expect(notificationArguments("post", "test-id")).toEqual([
    "post",
    "test-id",
    "T3 Code browser automation",
    "Automation clicking in 5 seconds. Typing and clicking may be briefly disturbed.",
  ]);
  expect(notificationArguments("remove", "test-id")).toEqual(["remove", "test-id"]);
  for (const id of ["", "../../file", "id\nremove", "x".repeat(129)])
    expect(() => notificationArguments("post", id)).toThrow();
});
