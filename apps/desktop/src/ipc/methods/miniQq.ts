import { DesktopMiniQqOpenRouteInputSchema } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as MiniQqWindow from "../../window/MiniQqWindow.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

export const toggle = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.MINI_QQ_TOGGLE_CHANNEL,
  payload: Schema.Undefined,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.miniQq.toggle")(function* () {
    const miniQq = yield* MiniQqWindow.MiniQqWindow;
    yield* miniQq.toggle;
  }),
});

export const hide = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.MINI_QQ_HIDE_CHANNEL,
  payload: Schema.Undefined,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.miniQq.hide")(function* () {
    const miniQq = yield* MiniQqWindow.MiniQqWindow;
    yield* miniQq.hide;
  }),
});

export const openInMainWindow = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.MINI_QQ_OPEN_IN_MAIN_CHANNEL,
  payload: DesktopMiniQqOpenRouteInputSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.miniQq.openInMainWindow")(function* ({ routePath }) {
    const miniQq = yield* MiniQqWindow.MiniQqWindow;
    yield* miniQq.openInMainWindow(routePath);
  }),
});

export const setMainReady = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.MINI_QQ_MAIN_READY_CHANNEL,
  payload: Schema.Boolean,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.miniQq.setMainReady")(function* (ready) {
    const miniQq = yield* MiniQqWindow.MiniQqWindow;
    yield* miniQq.setMainRendererReady(ready);
  }),
});
