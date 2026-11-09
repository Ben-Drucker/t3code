import * as Schema from "effect/Schema";

export const ScreenRect = Schema.Struct({
  x: Schema.Finite,
  y: Schema.Finite,
  width: Schema.Finite,
  height: Schema.Finite,
});
export type ScreenRect = typeof ScreenRect.Type;

export type WindowDockRequest =
  | { readonly type: "check"; readonly prompt: boolean }
  | { readonly type: "find"; readonly pid: number }
  | { readonly type: "watch"; readonly pid: number }
  | { readonly type: "unwatch"; readonly pid: number }
  | ({ readonly type: "setFrame"; readonly pid: number } & ScreenRect)
  | { readonly type: "minimize"; readonly pid: number; readonly minimized: boolean }
  | { readonly type: "raise"; readonly pid: number };

export const WindowDockReply = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("result"),
    id: Schema.Number,
    trusted: Schema.optional(Schema.Boolean),
    found: Schema.optional(Schema.Boolean),
    reason: Schema.optional(Schema.String),
    frame: Schema.optional(ScreenRect),
    contentTop: Schema.optional(Schema.Finite),
    error: Schema.optional(Schema.String),
  }),
  Schema.Struct({ type: Schema.Literal("closed"), pid: Schema.Number }),
]);
export type WindowDockReply = typeof WindowDockReply.Type;

export const decodeWindowDockReply = Schema.decodeUnknownOption(
  Schema.fromJsonString(WindowDockReply),
);
