import * as Schema from "effect/Schema";

export const ScreenRect = Schema.Struct({
  x: Schema.Finite,
  y: Schema.Finite,
  width: Schema.Finite,
  height: Schema.Finite,
});
export type ScreenRect = typeof ScreenRect.Type;

export const WindowDockCandidateWindow = Schema.Struct({
  windowId: Schema.Number,
  title: Schema.optional(Schema.String),
  pid: Schema.Number,
  standard: Schema.Boolean,
  minimized: Schema.Boolean,
  frame: ScreenRect,
});
export type WindowDockCandidateWindow = typeof WindowDockCandidateWindow.Type;

export type WindowDockRequest =
  | { readonly type: "check"; readonly prompt: boolean }
  | { readonly type: "find"; readonly pid: number }
  | { readonly type: "watch"; readonly pid: number; readonly windowId: number }
  | { readonly type: "unwatch"; readonly pid: number; readonly windowId?: number }
  | ({
      readonly type: "setFrame";
      readonly pid: number;
      readonly windowId: number;
    } & ScreenRect)
  | {
      readonly type: "minimize";
      readonly pid: number;
      readonly windowId: number;
      readonly minimized: boolean;
    }
  | { readonly type: "raise"; readonly pid: number; readonly windowId: number };

export const WindowDockReply = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("result"),
    id: Schema.Number,
    trusted: Schema.optional(Schema.Boolean),
    found: Schema.optional(Schema.Boolean),
    reason: Schema.optional(Schema.String),
    windowId: Schema.optional(Schema.Number),
    frame: Schema.optional(ScreenRect),
    windows: Schema.optional(Schema.Array(WindowDockCandidateWindow)),
    contentTop: Schema.optional(Schema.Finite),
    error: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    type: Schema.Literal("closed"),
    pid: Schema.Number,
    windowId: Schema.optional(Schema.Number),
  }),
  Schema.Struct({
    type: Schema.Literal("frameChanged"),
    pid: Schema.Number,
    windowId: Schema.Number,
    frame: ScreenRect,
  }),
]);
export type WindowDockReply = typeof WindowDockReply.Type;

export const decodeWindowDockReply = Schema.decodeUnknownOption(
  Schema.fromJsonString(WindowDockReply),
);
